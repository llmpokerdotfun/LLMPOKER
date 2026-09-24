import { describe, expect, it } from 'vitest';
import { EngineError, type TableConfig } from '@llmpoker/shared';
import { legalActions } from '../src/hand.js';
import {
  actOnTable,
  canStartHand,
  createTable,
  fundedSeats,
  leaveTable,
  nextButtonSeat,
  rebuy,
  seatAgent,
  seatedSeats,
  setTableStatus,
  startHand,
  timeoutAction,
} from '../src/table.js';
import type { TableState, TableStep } from '../src/table.js';
import { deckFor, testConfig } from './helpers.js';

const T0 = 1_700_000_000_000;

function table(config: TableConfig = testConfig(), now = T0): TableState {
  return createTable(config, now);
}

function seatThree(config: TableConfig = testConfig(), buyIn = 1_000n): TableState {
  let t = table(config);
  for (const seat of [0, 1, 2]) {
    t = seatAgent(t, { seat, agentId: `agent-${seat}`, agentName: `Agent ${seat}`, buyIn }, T0).table;
  }
  return t;
}

/** Folds whoever is on the clock until the hand ends. */
function foldOut(t: TableState, deckSeed = 1): TableStep {
  let step = startHand(t, { handId: `hand-${t.handNumber + 1}`, deck: deckFor(deckSeed), now: T0 + 1 });
  let guard = 0;
  while (!step.table.hand!.complete && guard++ < 50) {
    const seat = step.table.hand!.toActSeat!;
    step = actOnTable(step.table, seat, { action: 'FOLD' }, T0 + 2 + guard);
  }
  return step;
}

describe('createTable', () => {
  it('rejects a config that violates the invariants', () => {
    expect(() => createTable(testConfig({ bigBlind: 5n, smallBlind: 1n }), T0)).toThrow(/2x smallBlind/);
    expect(() => createTable(testConfig({ maxSeats: 7 }), T0)).toThrow(/maxSeats/);
    expect(() => createTable(testConfig({ minBuyIn: 10n }), T0)).toThrow(/10 big blinds/);
    expect(() => createTable(testConfig({ rakeBps: 2_000 }), T0)).toThrow(/rakeBps/);
  });

  it('starts empty, open, with no button and no hand', () => {
    const t = table();
    expect(t.status).toBe('OPEN');
    expect(t.buttonSeat).toBeNull();
    expect(t.hand).toBeNull();
    expect(t.handNumber).toBe(0);
    expect(t.seats).toHaveLength(6);
    expect(seatedSeats(t)).toHaveLength(0);
  });
});

describe('seating (FR-1.4, FR-5.1)', () => {
  it('seats an agent at an explicit seat and auto-assigns otherwise', () => {
    let t = table();
    const explicit = seatAgent(t, { seat: 3, agentId: 'a', agentName: 'A', buyIn: 200n }, T0);
    expect(explicit.seat).toBe(3);
    t = explicit.table;
    const auto = seatAgent(t, { agentId: 'b', agentName: 'B', buyIn: 200n }, T0);
    expect(auto.seat).toBe(0);
    expect(auto.table.seats[0]!.status).toBe('SITTING_OUT');
    expect(fundedSeats(auto.table)).toHaveLength(2);
  });

  it('enforces buy-in bounds, escrow and one seat per agent', () => {
    const t = table();
    expect(() => seatAgent(t, { agentId: 'a', agentName: 'A', buyIn: 10n }, T0)).toThrow(/buy-in must be between/);
    expect(() => seatAgent(t, { agentId: 'a', agentName: 'A', buyIn: 20_000n }, T0)).toThrow(/buy-in must be between/);
    expect(() =>
      seatAgent(t, { agentId: 'a', agentName: 'A', buyIn: 200n, escrowAvailable: 100n }, T0),
    ).toThrow(/does not cover/);

    const seated = seatAgent(t, { agentId: 'a', agentName: 'A', buyIn: 200n, escrowAvailable: 500n }, T0).table;
    expect(seated.seats[0]!.escrow).toBe(300n);
    expect(seated.seats[0]!.stack).toBe(200n);
    expect(() => seatAgent(seated, { agentId: 'a', agentName: 'A', buyIn: 200n }, T0)).toThrow(/already holds a seat/);
    expect(() => seatAgent(seated, { seat: 0, agentId: 'b', agentName: 'B', buyIn: 200n }, T0)).toThrow(/taken/);
    expect(() => seatAgent(seated, { seat: 9, agentId: 'b', agentName: 'B', buyIn: 200n }, T0)).toThrow(/out of range/);
  });

  it('refuses to seat anyone in the middle of a hand', () => {
    const t = seatThree();
    const step = startHand(t, { handId: 'h1', deck: deckFor(3), now: T0 });
    expect(() => seatAgent(step.table, { agentId: 'late', agentName: 'Late', buyIn: 200n }, T0)).toThrow(
      /middle of a hand/,
    );
  });

  it('reports a full table', () => {
    let t = table(testConfig({ maxSeats: 2 }));
    t = seatAgent(t, { agentId: 'a', agentName: 'A', buyIn: 200n }, T0).table;
    t = seatAgent(t, { agentId: 'b', agentName: 'B', buyIn: 200n }, T0).table;
    expect(() => seatAgent(t, { agentId: 'c', agentName: 'C', buyIn: 200n }, T0)).toThrow(/full/);
  });
});

describe('leaving and rebuying (FR-5.5)', () => {
  it('returns the stack plus untouched escrow on cash-out', () => {
    let t = seatAgent(table(), { seat: 2, agentId: 'a', agentName: 'A', buyIn: 200n, escrowAvailable: 700n }, T0).table;
    const left = leaveTable(t, 2, T0 + 1);
    expect(left.cashOut).toBe(200n);
    expect(left.escrow).toBe(500n);
    expect(left.agentId).toBe('a');
    expect(left.table.seats[2]!.agentId).toBeNull();
    expect(left.table.seats[2]!.status).toBe('EMPTY');
    t = left.table;
    expect(() => leaveTable(t, 2, T0 + 2)).toThrow(/empty/);
  });

  it('refuses to leave mid-hand', () => {
    const t = seatThree();
    const step = startHand(t, { handId: 'h1', deck: deckFor(4), now: T0 });
    expect(() => leaveTable(step.table, 0, T0)).toThrow(/middle of a hand/);
  });

  it('tops a stack up from escrow but respects the table maximum', () => {
    const config = testConfig({ maxBuyIn: 500n });
    let t = seatAgent(
      table(config),
      { seat: 0, agentId: 'a', agentName: 'A', buyIn: 200n, escrowAvailable: 700n },
      T0,
    ).table;
    expect(t.seats[0]!.escrow).toBe(500n);
    t = rebuy(t, 0, 300n, T0 + 1).table;
    expect(t.seats[0]!.stack).toBe(500n);
    expect(t.seats[0]!.escrow).toBe(200n);
    expect(() => rebuy(t, 0, 100n, T0 + 2)).toThrow(/exceed/);
    expect(() => rebuy(t, 0, 300n, T0 + 3)).toThrow(/escrow does not cover/);
    expect(() => rebuy(t, 0, 0n, T0 + 3)).toThrow(/must be positive/);
    expect(() => rebuy(t, 4, 10n, T0 + 4)).toThrow(/empty/);
  });
});

describe('hand lifecycle', () => {
  it('requires two funded seats and rotates the button to occupied seats', () => {
    let t = table();
    expect(canStartHand(t)).toBe(false);
    t = seatAgent(t, { seat: 1, agentId: 'a', agentName: 'A', buyIn: 1_000n }, T0).table;
    t = seatAgent(t, { seat: 4, agentId: 'b', agentName: 'B', buyIn: 1_000n }, T0).table;
    expect(canStartHand(t)).toBe(true);
    expect(nextButtonSeat(t)).toBe(1);

    const step = foldOut(t, 5);
    expect(step.table.handNumber).toBe(1);
    expect(step.table.buttonSeat).toBe(1);
    const after = step.table;
    expect(after.hand!.complete).toBe(true);
    expect(after.rngCommitment).toBeNull();

    const second = foldOut(after, 6);
    expect(second.table.buttonSeat).toBe(4); // rotated to the next occupied seat
    expect(second.table.handNumber).toBe(2);
  });

  it('refuses to start with fewer than two funded seats or on a paused table', () => {
    let t = seatAgent(table(), { seat: 0, agentId: 'a', agentName: 'A', buyIn: 200n }, T0).table;
    expect(() => startHand(t, { handId: 'h', deck: deckFor(1), now: T0 })).toThrow(/cannot start/);
    t = seatAgent(t, { seat: 1, agentId: 'b', agentName: 'B', buyIn: 200n }, T0).table;
    const paused = setTableStatus(t, 'PAUSED', T0);
    expect(canStartHand(paused)).toBe(false);
    expect(() => startHand(paused, { handId: 'h', deck: deckFor(1), now: T0 })).toThrow(/cannot start/);
  });

  it('writes the settled stacks back to the seats and updates seat status', () => {
    let t = seatThree(testConfig(), 100n);
    const step = foldOut(t, 9);
    const table1 = step.table;
    const result = table1.lastResult!;
    for (const seat of result.seats) {
      expect(table1.seats[seat.seat]!.stack.toString()).toBe(seat.endingStack);
    }
    const total = result.seats.reduce((acc, s) => acc + BigInt(s.endingStack), 0n);
    expect(total).toBe(300n);
    expect(result.totalRake).toBe('0');
  });

  it('applies the think-budget timeout as FOLD or CHECK with origin TIMEOUT (FR-3.5)', () => {
    let t = seatThree();
    const started = startHand(t, { handId: 'h1', deck: deckFor(2), now: T0 });
    const seat = started.table.hand!.toActSeat!;
    const timedOut = timeoutAction(started.table, T0 + 30_000);
    const record = timedOut.events.find((e) => e.type === 'ACTION_TAKEN');
    expect(record).toBeDefined();
    expect((record as { record: { origin: string; seat: number; action: string } }).record.origin).toBe('TIMEOUT');
    expect((record as { record: { seat: number } }).record.seat).toBe(seat);
    expect((record as { record: { action: string } }).record.action).toBe('FOLD');

    // checking is free postflop, so a timeout there must check instead
    let step = timeoutAction(started.table, T0 + 30_000);
    let guard = 0;
    while (step.table.hand!.street === 'PREFLOP' && guard++ < 20) {
      const next = step.table.hand!.toActSeat!;
      const legal = legalActions(step.table.hand!, next);
      step = actOnTable(step.table, next, legal.canCheck ? { action: 'CHECK' } : { action: 'CALL' }, T0 + 40_000 + guard);
    }
    expect(step.table.hand!.street).toBe('FLOP');
    const flopTimeout = timeoutAction(step.table, T0 + 50_000);
    const flopRecord = flopTimeout.events.find((e) => e.type === 'ACTION_TAKEN') as {
      record: { action: string; origin: string };
    };
    expect(flopRecord.record.action).toBe('CHECK');
    expect(flopRecord.record.origin).toBe('TIMEOUT');
    void t;
  });

  it('rejects actions when no hand is running', () => {
    const t = seatThree();
    expect(() => actOnTable(t, 0, { action: 'CALL' }, T0)).toThrow(/no live hand/);
    expect(() => timeoutAction(t, T0)).toThrow(/no seat on the clock/);
  });
});

describe('free-mode top-ups (FR-4.2)', () => {
  it('refills a busted seat to the table top-up amount', () => {
    const config = testConfig({ autoTopUp: 500n, maxSeats: 2, minBuyIn: 20n, maxBuyIn: 1_000n });
    let busted = false;

    for (let seed = 1; seed <= 40 && !busted; seed++) {
      let t = createTable(config, T0);
      t = seatAgent(t, { seat: 0, agentId: 'a', agentName: 'A', buyIn: 100n }, T0).table;
      t = seatAgent(t, { seat: 1, agentId: 'b', agentName: 'B', buyIn: 100n }, T0).table;
      let step = startHand(t, { handId: `h${seed}`, deck: deckFor(seed), now: T0 });
      let guard = 0;
      while (!step.table.hand!.complete && guard++ < 50) {
        const seat = step.table.hand!.toActSeat!;
        const legal = step.table.hand!.seats[seat]!;
        const action = legal.canRaise ? { action: 'ALL_IN' as const } : { action: 'CALL' as const };
        step = actOnTable(step.table, seat, action, T0 + guard);
      }
      const result = step.table.lastResult!;
      const loser = result.seats.find((s) => s.endingStack === '0');
      if (loser) {
        busted = true;
        expect(step.table.seats[loser.seat]!.stack).toBe(500n);
        const total = step.table.seats
          .filter((s) => s.agentId !== null)
          .reduce((acc, s) => acc + s.stack, 0n);
        // The loser's top-up is new play money; the winner keeps their winnings.
        expect(total).toBeGreaterThanOrEqual(500n + 100n);
      }
    }

    expect(busted).toBe(true);
  });

  it('does not top up when autoTopUp is null (wager tables)', () => {
    const config = testConfig({ autoTopUp: null, maxSeats: 2 });
    let t = createTable(config, T0);
    t = seatAgent(t, { seat: 0, agentId: 'a', agentName: 'A', buyIn: 100n }, T0).table;
    t = seatAgent(t, { seat: 1, agentId: 'b', agentName: 'B', buyIn: 100n }, T0).table;
    let step = startHand(t, { handId: 'h', deck: deckFor(3), now: T0 });
    let guard = 0;
    while (!step.table.hand!.complete && guard++ < 50) {
      const seat = step.table.hand!.toActSeat!;
      const action = step.table.hand!.seats[seat]!.canRaise ? { action: 'ALL_IN' as const } : { action: 'CALL' as const };
      step = actOnTable(step.table, seat, action, T0 + guard);
    }
    const result = step.table.lastResult!;
    const loser = result.seats.find((s) => s.endingStack === '0');
    if (loser) {
      expect(step.table.seats[loser.seat]!.stack).toBe(0n);
      expect(step.table.seats[loser.seat]!.status).toBe('BUSTED');
    }
  });
});

describe('error surface', () => {
  it('uses typed EngineError codes', () => {
    try {
      actOnTable(seatThree(), 0, { action: 'CALL' }, T0);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EngineError);
      expect((error as EngineError).code).toBe('HAND_NOT_FOUND');
    }
  });
});
