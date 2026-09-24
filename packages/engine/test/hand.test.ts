import { describe, expect, it } from 'vitest';
import {
  EngineError,
  type HandStep,
  type PlayerAction,
  type TableConfig,
  type TableEvent,
  cardToString,
  cardsToString,
  stringToCard,
} from '@llmpoker/shared';
import {
  applyAction,
  autoActionForTimeout,
  buildPots,
  createHand,
  legalActions,
  replayHand,
  splitPot,
  totalPot,
} from '../src/hand.js';
import { deckFor, stripTimes, testConfig, wagerConfig } from './helpers.js';

interface PlayerSpec {
  seat: number;
  agentId?: string;
  stack: bigint;
}

function makeHand(options: {
  players: PlayerSpec[];
  config?: TableConfig;
  buttonSeat?: number;
  deckSeed?: number;
  now?: number;
}): HandStep {
  const config = options.config ?? testConfig();
  const now = options.now ?? 1_700_000_000_000;
  return createHand({
    handId: 'h1',
    tableId: config.id,
    handNumber: 1,
    config,
    buttonSeat: options.buttonSeat ?? 0,
    players: options.players.map((p) => ({
      seat: p.seat,
      agentId: p.agentId ?? `agent-${p.seat}`,
      agentName: `Agent ${p.seat}`,
      stack: p.stack,
    })),
    deck: deckFor(options.deckSeed ?? 1),
    now,
  });
}

const sixPlayers = (stack = 1_000n): PlayerSpec[] =>
  [0, 1, 2, 3, 4, 5].map((seat) => ({ seat, stack }));

/** Applies an action using a monotonic clock so replays line up. */
function step(prev: HandStep, seat: number, action: PlayerAction, origin?: 'AGENT' | 'TIMEOUT'): HandStep {
  const now = prev.state.startedAt + (prev.state.seq + 1) * 1000;
  return applyAction(prev.state, seat, action, now, origin ?? 'AGENT');
}

function playOut(step0: HandStep, chooser: (s: HandStep) => PlayerAction | null): HandStep {
  let s = step0;
  for (let guard = 0; guard < 200 && !s.state.complete; guard++) {
    const seat = s.state.toActSeat;
    if (seat === null) throw new Error('no seat on the clock but the hand is not complete');
    const action = chooser(s);
    if (!action) throw new Error('chooser declined to act');
    s = step(s, seat, action);
  }
  if (!s.state.complete) throw new Error('hand did not finish');
  return s;
}

const callOrCheck = (s: HandStep): PlayerAction => {
  const seat = s.state.toActSeat!;
  return legalActions(s.state, seat).canCheck ? { action: 'CHECK' } : { action: 'CALL' };
};

describe('createHand', () => {
  it('deals 2 cards to each seat in small-blind-first order and posts blinds', () => {
    const s = makeHand({ players: sixPlayers(), buttonSeat: 0 });
    const events = s.events.map((e) => e.type);
    expect(events).toContain('HAND_STARTED');
    expect(events).toContain('BLIND_POSTED');

    // 6-max button at seat 0 ⇒ SB seat 1, BB seat 2, first to act is seat 3 (UTG).
    expect(s.state.smallBlindSeat).toBe(1);
    expect(s.state.bigBlindSeat).toBe(2);
    expect(s.state.toActSeat).toBe(3);
    expect(s.state.dealingOrder).toEqual([1, 2, 3, 4, 5, 0]);

    for (const seat of sixPlayers()) {
      expect(s.state.seats[seat.seat]!.holeCards).toHaveLength(2);
    }
    const allHoles = s.state.seats.flatMap((x) => x.holeCards);
    expect(new Set(allHoles).size).toBe(12);
    expect(s.state.currentBet).toBe(2n);
    expect(totalPot(s.state)).toBe(3n);
  });

  it('heads-up: the button posts the small blind and acts first preflop', () => {
    const s = makeHand({ players: [{ seat: 2, stack: 100n }, { seat: 5, stack: 100n }], buttonSeat: 2 });
    expect(s.state.smallBlindSeat).toBe(2);
    expect(s.state.bigBlindSeat).toBe(5);
    expect(s.state.toActSeat).toBe(2);
  });

  it('rejects fewer than two players and stacks of zero', () => {
    expect(() => makeHand({ players: [{ seat: 0, stack: 100n }] })).toThrow(EngineError);
    expect(() => makeHand({ players: [{ seat: 0, stack: 0n }, { seat: 1, stack: 100n }] })).toThrow(/no chips/);
  });

  it('never leaks an opponent hole card in a public event', () => {
    const s = makeHand({ players: sixPlayers() });
    const json = JSON.stringify(s.events);
    for (const seat of s.state.seats) {
      if (seat.holeCards.length === 0) continue;
      expect(json).not.toContain(JSON.stringify(seat.holeCards));
    }
    // The turn notification is separate and carries only the acting seat's cards.
    expect(s.actionRequest?.seat).toBe(s.state.toActSeat);
    expect(s.actionRequest?.holeCards).toEqual(s.state.seats[s.state.toActSeat!]!.holeCards);
    expect(s.events.some((e) => e.type === 'ACTION_REQUIRED')).toBe(false);
  });
});

describe('action validation (engine as referee, FR-3.6)', () => {
  it('rejects acting out of turn', () => {
    const s = makeHand({ players: sixPlayers() });
    expect(s.state.toActSeat).toBe(3);
    expect(() => step(s, 4, { action: 'CALL' })).toThrow(/cannot act/);
  });

  it('rejects checking when facing a bet and calling when there is nothing to call', () => {
    const s = makeHand({ players: sixPlayers() });
    expect(() => step(s, 3, { action: 'CHECK' })).toThrow(/cannot check/);

    // Everyone calls/checks to the flop: there the first actor has nothing to call.
    const flop = playOut(s, callOrCheck);
    expect(flop.state.complete).toBe(true);
    expect(flop.state.result!.totalRake).toBe('0');

    let toFlop = makeHand({ players: sixPlayers() });
    while (toFlop.state.street === 'PREFLOP') toFlop = step(toFlop, toFlop.state.toActSeat!, callOrCheck(toFlop));
    expect(toFlop.state.street).toBe('FLOP');
    const actor = toFlop.state.toActSeat!;
    expect(legalActions(toFlop.state, actor).canCall).toBe(false);
    expect(() => step(toFlop, actor, { action: 'CALL' })).toThrow(/nothing to call/);
  });

  it('enforces the minimum raise and reports the maximum as all-in', () => {
    const s = makeHand({ players: sixPlayers() });
    const legal = legalActions(s.state, 3);
    expect(legal.minRaiseTo).toBe('4'); // BB 2 ⇒ min raise to 4
    expect(legal.maxRaiseTo).toBe('1000');
    expect(() => step(s, 3, { action: 'RAISE', amount: 3n })).toThrow(/below the 4 minimum/);
    expect(() => step(s, 3, { action: 'RAISE', amount: 1001n })).toThrow(/exceeds the 1000 maximum/);
    expect(() => step(s, 3, { action: 'RAISE' })).toThrow(/requires an amount/);
  });

  it('allows an all-in below the minimum raise, and it does not reopen the betting', () => {
    // seats 0(btn) 1(SB) 2(BB); seat 0 acts first with 3 players.
    let s = makeHand({
      players: [{ seat: 0, stack: 1_000n }, { seat: 1, stack: 150n }, { seat: 2, stack: 1_000n }],
      buttonSeat: 0,
    });
    expect(s.state.toActSeat).toBe(0);
    s = step(s, 0, { action: 'RAISE', amount: 100n });
    s = step(s, 1, { action: 'ALL_IN' }); // 150 total: increment 50 < lastFullRaise 98 ⇒ short
    expect(s.state.seats[1]!.totalCommitted).toBe(150n);
    s = step(s, 2, { action: 'CALL' });

    expect(s.state.toActSeat).toBe(0);
    const legal = legalActions(s.state, 0);
    expect(legal.toCall).toBe('50');
    expect(legal.canRaise).toBe(false);
    expect(() => step(s, 0, { action: 'RAISE', amount: 300n })).toThrow(/not reopened/);
    s = step(s, 0, { action: 'CALL' });
    expect(s.state.street).toBe('FLOP');
  });

  it('lets a seat that has not yet acted raise over a short all-in', () => {
    // seat 0 shoves 3 (short of the 4 minimum), seat 1's action is still open.
    let s = makeHand({
      players: [{ seat: 0, stack: 3n }, { seat: 1, stack: 150n }, { seat: 2, stack: 1_000n }],
      buttonSeat: 0,
    });
    s = step(s, 0, { action: 'ALL_IN' });
    expect(s.state.toActSeat).toBe(1);
    const legal = legalActions(s.state, 1);
    expect(legal.canRaise).toBe(true);
    expect(legal.minRaiseTo).toBe('5'); // currentBet 3 + lastFullRaise 2
    s = step(s, 1, { action: 'RAISE', amount: 5n });
    expect(s.state.currentBet).toBe(5n);
  });

  it('rejects actions once the hand is complete', () => {
    const s = playOut(makeHand({ players: sixPlayers() }), callOrCheck);
    expect(() => step(s, 0, { action: 'CHECK' })).toThrow(/already complete/);
  });

  it('applies CHECK on timeout when checking is free, otherwise FOLD (FR-3.5)', () => {
    const preflop = makeHand({ players: sixPlayers() });
    expect(autoActionForTimeout(preflop.state)).toEqual({ action: 'FOLD' });

    let postflop = playOut(preflop, callOrCheck);
    expect(postflop.state.complete).toBe(true);

    const hu = makeHand({ players: [{ seat: 0, stack: 100n }, { seat: 1, stack: 100n }], buttonSeat: 0 });
    const called = step(hu, 0, { action: 'CALL' });
    const checked = step(called, 1, { action: 'CHECK' });
    expect(checked.state.street).toBe('FLOP');
    expect(autoActionForTimeout(checked.state)).toEqual({ action: 'CHECK' });
    // position: postflop the big blind (seat 1) acts first heads-up
    expect(checked.state.toActSeat).toBe(1);
  });
});

describe('pot math (FR-3.4)', () => {
  it('builds a main pot plus a side pot that only the deeper stacks contest', () => {
    const seats = [
      { seat: 0, totalCommitted: 50n, folded: false, agentId: 'a' },
      { seat: 1, totalCommitted: 200n, folded: false, agentId: 'b' },
      { seat: 2, totalCommitted: 200n, folded: true, agentId: 'c' },
    ] as never;
    const pots = buildPots(seats);
    expect(pots.map((p) => [p.amount, p.eligible])).toEqual([
      [150n, [0, 1]],
      [300n, [1]],
    ]);
    expect(pots.reduce((acc, p) => acc + p.amount, 0n)).toBe(450n);
  });

  it('separates a genuine main pot from a side pot', () => {
    const seats = [
      { seat: 0, totalCommitted: 100n, folded: false, agentId: 'a' },
      { seat: 1, totalCommitted: 100n, folded: false, agentId: 'b' },
      { seat: 2, totalCommitted: 300n, folded: false, agentId: 'c' },
      { seat: 3, totalCommitted: 300n, folded: false, agentId: 'd' },
    ] as never;
    const pots = buildPots(seats);
    expect(pots.map((p) => [p.amount, p.eligible])).toEqual([
      [400n, [0, 1, 2, 3]],
      [400n, [2, 3]],
    ]);
  });

  it('sends the odd chip to the first winner clockwise from the button', () => {
    expect(splitPot(7n, [0, 3], 1, 6)).toEqual([
      { seat: 3, amount: 4n },
      { seat: 0, amount: 3n },
    ]);
    expect(splitPot(8n, [0, 3], 1, 6)).toEqual([
      { seat: 3, amount: 4n },
      { seat: 0, amount: 4n },
    ]);
  });

  it('splits a pot evenly between exact ties and keeps the books balanced', () => {
    const s = playOut(makeHand({ players: sixPlayers() }), callOrCheck);
    const result = s.state.result!;
    const awarded = result.pots.flatMap((p) => p.winners.map((w) => BigInt(w.amount)));
    const gross = result.pots.reduce((acc, p) => acc + BigInt(p.amount), 0n);
    expect(awarded.reduce((a, b) => a + b, 0n)).toBe(gross - BigInt(result.totalRake));
    expect(result.totalRake).toBe('0'); // free table: no rake at all
    expect(result.zeroSumVerified).toBe(true);
    expect(result.seats.reduce((acc, x) => acc + BigInt(x.net), 0n)).toBe(0n);
    expect(s.state.street).toBe('COMPLETE');
  });

  it('refunds an uncalled bet when everyone folds', () => {
    // 3-handed: seat 0 raises to 100, everyone folds.
    let s = makeHand({
      players: [{ seat: 0, stack: 1_000n }, { seat: 1, stack: 1_000n }, { seat: 2, stack: 1_000n }],
      buttonSeat: 0,
    });
    s = step(s, 0, { action: 'RAISE', amount: 100n });
    s = step(s, 1, { action: 'FOLD' });
    s = step(s, 2, { action: 'FOLD' });
    const result = s.state.result!;
    // Only the contested 5 chips remain in the pot once the uncalled 95 come back.
    expect(result.totalPot).toBe('5');
    expect(result.totalRake).toBe('0'); // no flop, no rake (FR-8.1)
    const seat0 = result.seats.find((x) => x.seat === 0)!;
    expect(seat0.net).toBe('3');
    expect(result.zeroSumVerified).toBe(true);
  });

  it('takes rake only when a flop is seen, respecting the cap (FR-8.1)', () => {
    const config = wagerConfig({ rakeBps: 250, rakeCap: 1_000n });
    const players = [
      { seat: 0, stack: 10_000n },
      { seat: 1, stack: 10_000n },
      { seat: 2, stack: 10_000n },
    ];

    // Flop seen: 3 players × 20 = 60 pot ⇒ 2.5% = 1.5 ⇒ 1 chip.
    const withFlop = playOut(makeHand({ players, config, deckSeed: 7 }), callOrCheck);
    expect(withFlop.state.result!.totalRake).toBe('1');

    // No flop: a preflop raise takes it down, so rake must be zero.
    let preflopOnly = makeHand({ players, config, deckSeed: 7 });
    preflopOnly = step(preflopOnly, 0, { action: 'RAISE', amount: 100n });
    preflopOnly = step(preflopOnly, 1, { action: 'FOLD' });
    preflopOnly = step(preflopOnly, 2, { action: 'FOLD' });
    expect(preflopOnly.state.result!.totalRake).toBe('0');
    expect(preflopOnly.state.result!.zeroSumVerified).toBe(true);
  });

  it('caps rake and never pays out more than the pot', () => {
    const config = wagerConfig({ rakeBps: 1_000, rakeCap: 3n });
    const players = [
      { seat: 0, stack: 1_000n },
      { seat: 1, stack: 1_000n },
    ];
    const s = playOut(makeHand({ players, config, deckSeed: 11 }), callOrCheck);
    const result = s.state.result!;
    expect(result.totalRake).toBe('3'); // 10% of 40 would be 4, the cap wins
    expect(result.zeroSumVerified).toBe(true);
  });
});

describe('replay (NFR-4, NFR-5)', () => {
  it('reproduces a played hand exactly', () => {
    const config = testConfig();
    const deckSeed = 99;
    const played = playOut(makeHand({ players: sixPlayers(500n), config, deckSeed }), callOrCheck);
    const replayed = replayHand({ result: played.state.result!, deck: deckFor(deckSeed), config });
    expect(stripTimes(replayed)).toEqual(stripTimes(played.state.result!));
  });

  it('reproduces a hand with raises, folds and all-ins', () => {
    const config = testConfig();
    const deckSeed = 123;
    let s = makeHand({ players: sixPlayers(300n), config, deckSeed });
    s = step(s, s.state.toActSeat!, { action: 'RAISE', amount: 10n });
    s = step(s, s.state.toActSeat!, { action: 'FOLD' });
    s = step(s, s.state.toActSeat!, { action: 'ALL_IN' });
    s = playOut(s, callOrCheck);
    const replayed = replayHand({ result: s.state.result!, deck: deckFor(deckSeed), config });
    expect(stripTimes(replayed)).toEqual(stripTimes(s.state.result!));
  });
});

describe('deck consumption and privacy', () => {
  it('consumes 2·seats + 8 cards with burns, and the board comes from the shuffled deck', () => {
    const s = playOut(makeHand({ players: sixPlayers() }), callOrCheck);
    const used = new Set<number>();
    for (const seat of s.state.seats) for (const c of seat.holeCards) used.add(c);
    for (const c of s.state.board) used.add(c);
    for (const c of s.state.burnCards) used.add(c);
    expect(used.size).toBe(12 + 5 + 3);
    expect(s.state.burnCards).toHaveLength(3);
    expect(s.state.board).toHaveLength(5);
    expect(cardsToString(s.state.board.slice(0, 3).map((c) => c))).toBe(
      cardsToString(s.state.deal.flop),
    );
  });

  it('describes the winning hand in the showdown payload', () => {
    const s = playOut(makeHand({ players: sixPlayers() }), callOrCheck);
    const result = s.state.result!;
    expect(result.showdown).toHaveLength(6);
    for (const reveal of result.showdown) {
      expect(reveal.cards).toHaveLength(2);
      expect(reveal.category).not.toBeNull();
      expect(reveal.description).toBeTruthy();
      expect(() => cardToString(reveal.cards[0]!)).not.toThrow();
    }
    expect(result.pots.length).toBeGreaterThan(0);
  });

  it('marks folded seats and keeps their hole cards in the history', () => {
    let s = makeHand({
      players: [{ seat: 0, stack: 1_000n }, { seat: 1, stack: 1_000n }, { seat: 2, stack: 1_000n }],
      buttonSeat: 0,
    });
    const folder = s.state.toActSeat!;
    s = step(s, folder, { action: 'FOLD' });
    s = playOut(s, callOrCheck);
    const seat = s.state.result!.seats.find((x) => x.seat === folder)!;
    expect(seat.folded).toBe(true);
    expect(seat.holeCards).toHaveLength(2);
    expect(s.state.result!.showdown.some((r) => r.seat === folder)).toBe(false);
  });
});

describe('ante tables', () => {
  it('posts antes into the pot without affecting the bet to call', () => {
    const config = testConfig({ ante: 5n });
    const s = makeHand({ players: sixPlayers(), config });
    expect(totalPot(s.state)).toBe(3n + 30n);
    expect(s.state.currentBet).toBe(2n);
    const anteEvents = s.events.filter((e) => e.type === 'BLIND_POSTED' && e.kind === 'ANTE');
    expect(anteEvents).toHaveLength(6);
    const played = playOut(s, callOrCheck);
    expect(played.state.result!.zeroSumVerified).toBe(true);
  });
});

describe('multiset of table events', () => {
  it('emits a coherent public event stream for a full hand', () => {
    let s = makeHand({ players: sixPlayers() });
    const all: TableEvent[] = [...s.events];
    for (let guard = 0; guard < 200 && !s.state.complete; guard++) {
      const seat = s.state.toActSeat;
      if (seat === null) break;
      s = step(s, seat, callOrCheck(s));
      all.push(...s.events);
    }
    const types: TableEvent['type'][] = all.map((e) => e.type);
    expect(types[0]).toBe('HAND_STARTED');
    expect(types).toContain('STREET_ADVANCED');
    expect(types).toContain('SHOWDOWN');
    expect(types).toContain('POT_AWARDED');
    expect(types).toContain('ACTION_TAKEN');
    expect(types[types.length - 1]).toBe('HAND_COMPLETE');
    const streets = all.filter((e) => e.type === 'STREET_ADVANCED').map((e) => (e as { street: string }).street);
    expect(streets).toEqual(['FLOP', 'TURN', 'RIVER']);
    expect(all.filter((e) => e.type === 'HOLE_CARDS_DEALT')).toHaveLength(6);
  });
});
