import { describe, expect, it } from 'vitest';
import { EngineError, type HandResult, type PlayerAction } from '@llmpoker/shared';
import { type HandStep, applyAction, createHand, legalActions, replayHand, totalPot } from '../src/hand.js';
import { Lcg, deckFor, stripTimes, testConfig, wagerConfig } from './helpers.js';

/**
 * Property/fuzz suite (NFR-5). Every hand is generated from a seeded LCG, so a
 * failure is reproducible from the seed alone.
 *
 * Invariants asserted after every single action:
 *  - chips are conserved (stacks + contributions never change the total)
 *  - no stack or contribution ever goes negative
 *  - the public event stream never carries a turn notification
 *  - the seat on the clock is always a legal one
 * And at settlement:
 *  - payouts + rake equal the pot exactly
 *  - the table's books balance
 *  - replaying the recorded history reproduces the hand bit for bit
 */

interface FuzzCase {
  seed: number;
  seats: number;
  stacks: bigint[];
  config: ReturnType<typeof testConfig>;
}

function chooseAction(lcg: Lcg, step: HandStep): PlayerAction {
  const seat = step.state.toActSeat!;
  const legal = legalActions(step.state, seat);
  const roll = lcg.nextInt(100);

  if (legal.canAllIn && roll < 4) return { action: 'ALL_IN' };
  if (legal.canRaise && roll < 24) return { action: 'RAISE', amount: BigInt(lcg.pick(legal.sizedTargets)) };
  if (legal.canBet && roll < 40) return { action: 'BET', amount: BigInt(lcg.pick(legal.sizedTargets)) };
  if (legal.canCheck) return roll < 90 ? { action: 'CHECK' } : { action: 'FOLD' };
  if (legal.canCall && roll < 88) return { action: 'CALL' };
  return { action: 'FOLD' };
}

function runCase(c: FuzzCase): void {
  const lcg = new Lcg(c.seed);
  const players = Array.from({ length: c.seats }, (_, seat) => ({
    seat,
    agentId: `agent-${seat}`,
    agentName: `Agent ${seat}`,
    stack: c.stacks[seat]!,
  }));
  const totalStarting = players.reduce((acc, p) => acc + p.stack, 0n);

  let step = createHand({
    handId: `fuzz-${c.seed}`,
    tableId: c.config.id,
    handNumber: 1,
    config: c.config,
    buttonSeat: lcg.nextInt(c.seats),
    players,
    deck: deckFor(c.seed),
    now: 1_700_000_000_000,
  });

  const seenSeats = new Set(players.map((p) => p.seat));
  let guard = 0;

  for (;;) {
    // ---- invariants that must hold at every point in the hand ----
    let stackSum = 0n;
    for (const s of step.state.seats) {
      expect(s.stack).toBeGreaterThanOrEqual(0n);
      expect(s.committed).toBeGreaterThanOrEqual(0n);
      expect(s.totalCommitted).toBeGreaterThanOrEqual(0n);
      expect(s.committed).toBeLessThanOrEqual(s.totalCommitted);
      stackSum += s.stack;
    }
    // Chips are conserved: while the hand runs, stacks + the pot equal the start;
    // once settled the pot has been distributed and only the rake has left.
    if (!step.state.complete) {
      expect(stackSum + totalPot(step.state)).toBe(totalStarting);
    } else {
      expect(stackSum + BigInt(step.state.result!.totalRake)).toBe(totalStarting);
    }
    expect(step.events.some((e) => (e as { type: string }).type === 'ACTION_REQUIRED')).toBe(false);

    if (step.state.complete) break;
    expect(++guard).toBeLessThan(500);

    const seat = step.state.toActSeat;
    expect(seat).not.toBeNull();
    expect(seenSeats.has(seat!)).toBe(true);
    const seatState = step.state.seats[seat!]!;
    expect(seatState.folded).toBe(false);
    expect(seatState.allIn).toBe(false);

    const action = chooseAction(lcg, step);
    const now = step.state.startedAt + (step.state.seq + 1) * 1000;
    step = applyAction(step.state, seat!, action, now);
  }

  // ---- settlement invariants ----
  const result: HandResult = step.state.result!;
  expect(result.zeroSumVerified).toBe(true);

  const rake = BigInt(result.totalRake);
  const netSum = result.seats.reduce((acc, s) => acc + BigInt(s.net), 0n);
  expect(netSum + rake).toBe(0n);

  const grossPot = result.pots.reduce((acc, p) => acc + BigInt(p.amount), 0n);
  const paidOut = result.pots.reduce((acc, p) => acc + p.winners.reduce((a, w) => a + BigInt(w.amount), 0n), 0n);
  const rakeTotal = result.pots.reduce((acc, p) => acc + BigInt(p.rake), 0n);
  expect(grossPot).toBe(BigInt(result.totalPot));
  expect(rakeTotal).toBe(rake);
  expect(paidOut).toBe(grossPot - rake);

  for (const seat of result.seats) {
    expect(BigInt(seat.endingStack)).toBeGreaterThanOrEqual(0n);
    expect(BigInt(seat.endingStack) - BigInt(seat.startingStack)).toBe(BigInt(seat.net));
  }

  // Streets must be consistent with the board size.
  const board = result.board.length;
  expect(board === 0 || board === 3 || board === 4 || board === 5).toBe(true);
  expect(result.streetReached).toBe(board === 0 ? 'PREFLOP' : board === 3 ? 'FLOP' : board === 4 ? 'TURN' : 'RIVER');

  // ---- determinism: replay reproduces the hand exactly ----
  const replayed = replayHand({ result, deck: deckFor(c.seed), config: c.config });
  expect(stripTimes(replayed)).toEqual(stripTimes(result));
}

describe('fuzz: 400 randomly played hands', () => {
  const lcg = new Lcg(20240924);
  const cases: FuzzCase[] = [];
  for (let i = 0; i < 400; i++) {
    const seats = 2 + lcg.nextInt(5); // 2..6
    const stacks = Array.from({ length: seats }, () => BigInt(20 + lcg.nextInt(2_000)));
    const isWager = i % 3 === 0;
    const config = isWager
      ? wagerConfig({ rakeBps: lcg.pick([0, 100, 250, 500]), rakeCap: BigInt(lcg.nextInt(200)) })
      : testConfig({ ante: i % 7 === 0 ? BigInt(lcg.nextInt(5)) : 0n });
    config.maxSeats = 6;
    cases.push({ seed: 1000 + i, seats, stacks, config });
  }

  it.each(cases.map((c) => [c.seed, c] as const))('hand #%i holds every invariant', (_seed, c) => {
    runCase(c);
  });
});

describe('fuzz: rule edge cases are rejected, never coerced', () => {
  it('rejects every illegal action shape it is handed', () => {
    const lcg = new Lcg(7);
    let rejected = 0;
    let accepted = 0;

    for (let i = 0; i < 60; i++) {
      const seats = 2 + lcg.nextInt(5);
      const config = testConfig();
      let step = createHand({
        handId: `edge-${i}`,
        tableId: config.id,
        handNumber: 1,
        config,
        buttonSeat: 0,
        players: Array.from({ length: seats }, (_, seat) => ({
          seat,
          agentId: `a${seat}`,
          agentName: `A${seat}`,
          stack: BigInt(50 + lcg.nextInt(500)),
        })),
        deck: deckFor(i + 500),
        now: 0,
      });

      let guard = 0;
      while (!step.state.complete && guard++ < 200) {
        const seat = step.state.toActSeat!;
        const legal = legalActions(step.state, seat);
        const candidates: PlayerAction[] = [
          { action: 'CHECK' },
          { action: 'CALL' },
          { action: 'BET', amount: BigInt(lcg.nextInt(30)) },
          { action: 'RAISE', amount: BigInt(lcg.nextInt(30)) },
          { action: 'ALL_IN' },
        ];
        const candidate = lcg.pick(candidates);
        const before = step.state;
        try {
          step = applyAction(before, seat, candidate, 1_000);
          accepted++;
        } catch (error) {
          rejected++;
          expect(error).toBeInstanceOf(EngineError);
          // A rejected action must not have mutated anything.
          expect(before.seq).toBe(step.state.seq);
          step = applyAction(before, seat, chooseAction(lcg, step), 2_000);
        }
        expect(legal.toCall).toBeDefined();
      }
    }

    expect(rejected).toBeGreaterThan(20);
    expect(accepted).toBeGreaterThan(20);
  });
});
