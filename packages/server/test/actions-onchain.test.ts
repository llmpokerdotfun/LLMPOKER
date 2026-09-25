/**
 * On-chain action recording from the server's side (FR-10.4 companion).
 *
 * `Poker.recordAction` itself is proven in `contracts/test/Poker.actions.test.ts`; this file proves
 * the *wiring*: that the orchestrator relays the agent's signed action before it applies it, that
 * `LLMPOKER_ACTIONS_ONCHAIN` really is the switch (off by default), and — most importantly — that a
 * chain failure rejects the action instead of being swallowed. That last property is the reason the
 * record is worth having: the server's hand history and the chain must not be allowed to drift.
 *
 * No RPC and no operator key are needed. `actionsOnChain` is gated on the adapter's own `kind`, so
 * an `ONCHAIN`-flagged recording stand-in exercises the production branch exactly.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { defaultFreeTableConfig, defaultWagerTableConfig, type TableConfig } from '@llmpoker/shared';

import { LocalChain, type RecordActionParams, type SettlementReceipt, type SettlementAdapter } from '../src/chain.js';
import { loadConfig } from '../src/config.js';
import { Orchestrator } from '../src/orchestrator.js';
import { Store } from '../src/store.js';

const TABLE_ID = 'wager-actions';

/**
 * A settlement adapter that records what it is asked to record.
 *
 * `kind: 'ONCHAIN'` is the point: it is what the orchestrator checks, so this stand-in takes the
 * real production branch while keeping the test offline. Everything else is inert — the test drives
 * `orchestrator.act` directly, so no hand needs to be opened on a chain.
 */
class RecordingSettlement implements SettlementAdapter {
  readonly kind = 'ONCHAIN' as const;
  /**
   * `true` (the real on-chain setting) so `seat` takes the on-chain deposit path and trusts the
   * caller's explicit seat rather than looking for a local escrow balance the stand-in has none of.
   */
  readonly clientSideDeposits = true;
  readonly calls: RecordActionParams[] = [];
  /** Set to make the next `recordAction` throw, standing in for a chain revert. */
  failWith: Error | null = null;

  private receipt(note: string): SettlementReceipt {
    return { kind: 'ONCHAIN', txHash: `0x${'11'.repeat(32)}`, block: 7, note };
  }

  async recordAction(params: RecordActionParams): Promise<SettlementReceipt> {
    this.calls.push(params);
    if (this.failWith) throw this.failWith;
    return this.receipt(`recordAction:${params.handId}:${params.seat}`);
  }

  async escrowOf(): Promise<bigint> {
    // Reports a healthy balance so `seat` accepts the seat. In on-chain mode the server never moves
    // tokens itself — it only *verifies* the balance an agent's own `Poker.deposit` produced
    // (FR-5.3) — so standing in for that read is the whole of the adapter's seating responsibility.
    return 1_000_000_000_000_000_000_000n;
  }
  async ensureTable(_config: TableConfig): Promise<SettlementReceipt | null> {
    return null;
  }
  async openHand(): Promise<SettlementReceipt | null> {
    return null;
  }
  async commitHand(): Promise<SettlementReceipt | null> {
    return null;
  }
  async settleHand(): Promise<SettlementReceipt> {
    return this.receipt('settleHand');
  }
  async voidHand(): Promise<SettlementReceipt | null> {
    return null;
  }
  async deposit(): Promise<SettlementReceipt | null> {
    return null;
  }
  async cashOut(): Promise<SettlementReceipt | null> {
    return null;
  }
  balances(): Map<string, bigint> {
    return new Map();
  }
  houseBalance(): bigint {
    return 0n;
  }
  async close(): Promise<void> {
    // nothing to release
  }
}

interface Harness {
  orchestrator: Orchestrator;
  settlement: RecordingSettlement;
  store: Store;
  clock: { now: number };
}

const tempDirs: string[] = [];

async function build(options: { actionsOnChain: boolean }): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'llmpoker-actions-'));
  tempDirs.push(dataDir);
  const clock = { now: 1_760_000_000_000 };
  const config = loadConfig({
    LLMPOKER_ROOT: process.cwd(),
    LLMPOKER_DATA_DIR: dataDir,
    LLMPOKER_PERSIST: 'false',
    LLMPOKER_BLOCK_TIME_MS: '0',
    LLMPOKER_FREE_TABLES: '0',
    LLMPOKER_WAGER_TABLES: '0',
    LLMPOKER_JWT_SECRET: 'test-secret',
    LLMPOKER_LOG_LEVEL: 'silent',
    LLMPOKER_ACTIONS_ONCHAIN: options.actionsOnChain ? 'true' : 'false',
  });
  const store = new Store({ dataDir: config.dataDir, persist: false });
  const settlement = new RecordingSettlement();
  const orchestrator = new Orchestrator({
    config,
    store,
    anchor: new LocalChain(0, 5_000),
    settlement,
    now: () => clock.now,
  });
  // Tables are added directly so the test does not depend on the boot-time table list.
  orchestrator.addTable(defaultWagerTableConfig(TABLE_ID, 'Wager Actions', 0, 'TOKEN'));
  return { orchestrator, settlement, store, clock };
}

/** Register an agent directly in the store (no HTTP, no API key round trip needed here). */
function addAgent(harness: Harness, name: string): string {
  const record = harness.store.createAgent({
    name,
    wallet: Wallet.createRandom().address,
    metadata: { model: 'test' },
    now: harness.clock.now,
  });
  return record.agent.id;
}

/**
 * Seat two agents and deal a hand, returning the seat **on the clock** and a legal action for it.
 *
 * Picking the agent on the clock matters: `orchestrator.act` builds and relays the record before the
 * engine sees the action, so a test that picked the wrong seat would still prove the relay but fail
 * on "not your turn". A hand needs at least two funded seats, and the deposit against the recording
 * adapter is inert, so no chain is involved and the hand can start without a real node.
 */
async function seatAndDeal(
  harness: Harness,
  tableId = TABLE_ID,
): Promise<{ agentId: string; seat: number; handId: string; action: 'CHECK' | 'CALL' }> {
  const { orchestrator } = harness;
  const first = addAgent(harness, 'Relay Agent');
  const second = addAgent(harness, 'Relay Other');
  const table = orchestrator.getTable(tableId);
  // The table's own floor, so the same helper works for a wager table and for the free tier. Seats
  // are explicit because on-chain mode requires it (`Poker.deposit` is per seat).
  const buyIn = table.state.config.minBuyIn;
  await orchestrator.seat(first, tableId, { seat: 0, buyIn });
  await orchestrator.seat(second, tableId, { seat: 1, buyIn });

  for (let i = 0; i < 20 && !table.state.hand; i++) {
    await orchestrator.tick(harness.clock.now + (i + 1) * 4_000);
  }
  const hand = table.state.hand;
  if (!hand || hand.complete) throw new Error('no hand was dealt');

  const request = orchestrator.actionRequest(table);
  if (!request) throw new Error('no seat is on the clock');
  const agentId = hand.seats[request.seat]?.agentId;
  if (!agentId) throw new Error(`seat ${request.seat} has no agent`);
  return {
    agentId,
    seat: request.seat,
    handId: hand.handId,
    action: request.legal.canCheck ? 'CHECK' : 'CALL',
  };
}

const SIGNED = { signature: `0x${'ab'.repeat(65)}`, nonce: 7n, deadline: 4_000_000_000 };

describe('on-chain action recording (server wiring)', () => {
  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  it('relays the signed action, forwarding exactly what the agent signed', async () => {
    const harness = await build({ actionsOnChain: true });
    const { agentId, seat, handId, action } = await seatAndDeal(harness);

    await harness.orchestrator.act(agentId, TABLE_ID, { action }, { onChain: SIGNED });

    expect(harness.settlement.calls).toHaveLength(1);
    const call = harness.settlement.calls[0]!;
    expect(call.tableId).toBe(TABLE_ID);
    expect(call.handId).toBe(handId);
    expect(call.seat).toBe(seat);
    // The action enum is the signed one, and the signature/nonce/deadline are passed through
    // untouched — the contract recovers the agent's wallet from exactly those bytes.
    expect(call.action).toBe(action === 'CHECK' ? 1 : 2);
    expect(call.amount).toBe(0n);
    expect(call.nonce).toBe(7n);
    expect(call.deadline).toBe(4_000_000_000);
    expect(call.agentId).toBe(agentId);
    expect(call.signature).toBe(SIGNED.signature);
  });

  it('records BET with the engine-read amount rather than anything the operator supplies', async () => {
    // Preflop the seat on the clock can always raise, so this needs no special state.
    const harness = await build({ actionsOnChain: true });
    const { agentId } = await seatAndDeal(harness);
    const table = harness.orchestrator.getTable(TABLE_ID);
    const request = harness.orchestrator.actionRequest(table)!;
    expect(request.legal.canBet || request.legal.canRaise).toBe(true);
    const target = BigInt(request.legal.minRaiseTo);

    // The amount comes from the *action*, which is the value the agent signed; the operator has no
    // separate channel for it. That is what makes a relayed signature meaningful.
    await harness.orchestrator.act(
      agentId,
      TABLE_ID,
      { action: 'RAISE', amount: target },
      { onChain: { ...SIGNED, nonce: 1n } },
    );
    const call = harness.settlement.calls.at(-1)!;
    expect(call.action).toBe(4); // RAISE
    expect(call.amount).toBe(target);
  });

  it('does not relay when LLMPOKER_ACTIONS_ONCHAIN is off (the default)', async () => {
    const harness = await build({ actionsOnChain: false });
    const { agentId, action } = await seatAndDeal(harness);
    expect(harness.orchestrator.config.actionsOnChain).toBe(false);

    await harness.orchestrator.act(agentId, TABLE_ID, { action }, { onChain: SIGNED });

    expect(harness.settlement.calls).toHaveLength(0);
  });

  it('rejects the action — and does not apply it — when the chain call fails', async () => {
    const harness = await build({ actionsOnChain: true });
    const { agentId, action } = await seatAndDeal(harness);
    const table = harness.orchestrator.getTable(TABLE_ID);
    const seatOnClock = table.state.hand!.toActSeat;

    harness.settlement.failWith = new Error('recordAction reverted: ActionSignerMismatch(0, ...)');
    await expect(
      harness.orchestrator.act(agentId, TABLE_ID, { action }, { onChain: SIGNED }),
    ).rejects.toThrow(/ActionSignerMismatch/);

    // The error propagated rather than being swallowed, and the engine was never advanced: this is
    // the ordering guarantee that makes "recorded" mean "verified before it happened".
    expect(table.state.hand!.toActSeat).toBe(seatOnClock);
    expect(harness.settlement.calls).toHaveLength(1);
  });

  it('never relays a free-mode action, even with the flag on', async () => {
    const harness = await build({ actionsOnChain: true });
    const table = defaultFreeTableConfig('free-actions', 'Free Actions', 0);
    harness.orchestrator.addTable(table);
    const { agentId } = await seatAndDeal(harness, table.id);
    expect(harness.orchestrator.config.actionsOnChain).toBe(true);

    // Free mode carries no signature at all — the act handler only builds one for a WAGER table — so
    // the call arrives exactly as app.ts sends it for a free table: no `onChain` option. Nothing
    // reaches the chain even with the flag on, which is what "free mode stays entirely off-chain"
    // means in practice. FOLD is legal from any seat, so no state has to be arranged first.
    await harness.orchestrator.act(agentId, table.id, { action: 'FOLD' });
    expect(harness.settlement.calls).toHaveLength(0);
  });
});
