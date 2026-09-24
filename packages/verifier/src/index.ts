/**
 * `@llmpoker/verifier` — independent verification of a hand.
 *
 * This package deliberately depends on nothing but `@llmpoker/shared` and
 * `@llmpoker/engine`: no server code, no database, no chain client. A third
 * party can point it at a published hand history (or a raw audit log) and get
 * back a verdict it computed itself.
 */

import {
  type HandHistory,
  type HandResult,
  type ProofVerification,
  type RngProof,
  type TableConfig,
  cardToString,
  chipsToTokenString,
  fromConfigJson,
  verifyHandDeal,
  verifyRngProof,
} from '@llmpoker/shared';
import { replayHand } from '@llmpoker/engine';

export interface HandVerdict {
  handId: string;
  tableId: string;
  ok: boolean;
  /** Commit-reveal / entropy / shuffle checks (FR-6.3). */
  proof: ProofVerification;
  /** The dealt cards really came from the verified deck (FR-6.3, step 7). */
  deal: ProofVerification;
  /** Re-running the recorded actions reproduces the published result (NFR-4). */
  replay: { ok: boolean; detail: string } | null;
  /** Pot/rake/stack arithmetic balances. */
  settlement: ProofVerification;
}

export interface VerifyHandOptions {
  /** Require a fully revealed proof (default true). For an in-flight hand, pass false. */
  requireReveal?: boolean;
  minAnchorConfirmations?: number;
  /** Skip the deterministic replay (it needs the table config). */
  skipReplay?: boolean;
}

function check(name: string, ok: boolean, detail?: string): { name: string; ok: boolean; detail?: string } {
  return detail === undefined ? { name, ok } : { name, ok, detail };
}

/** Arithmetic and conservation checks on a published result. */
export function verifySettlement(result: HandResult): ProofVerification {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const rake = BigInt(result.totalRake);
  const net = result.seats.reduce((acc, s) => acc + BigInt(s.net), 0n);
  checks.push(check('settlement.books_balance', net + rake === 0n, `Σ net = ${net}, rake = ${rake}`));

  const gross = result.pots.reduce((acc, p) => acc + BigInt(p.amount), 0n);
  checks.push(check('settlement.pot_total_matches', gross === BigInt(result.totalPot), `Σ pots = ${gross}, totalPot = ${result.totalPot}`));

  const paid = result.pots.reduce((acc, p) => acc + p.winners.reduce((a, w) => a + BigInt(w.amount), 0n), 0n);
  const rakeSum = result.pots.reduce((acc, p) => acc + BigInt(p.rake), 0n);
  checks.push(check('settlement.payouts_match_pot', paid === gross - rake, `paid ${paid} vs pot ${gross} - rake ${rake}`));
  checks.push(check('settlement.rake_total_matches', rakeSum === rake, `Σ pot rake = ${rakeSum}, totalRake = ${rake}`));
  checks.push(check('settlement.rake_non_negative', rake >= 0n && rake <= gross, `rake ${rake} of pot ${gross}`));

  for (const award of result.pots) {
    const winnerSum = award.winners.reduce((a, w) => a + BigInt(w.amount), 0n);
    checks.push(
      check(
        `settlement.pot_${award.potIndex}_distributes`,
        winnerSum === BigInt(award.amount) - BigInt(award.rake),
        `${winnerSum} vs ${award.amount} - ${award.rake}`,
      ),
    );
  }

  const nets = new Map(result.seats.map((s) => [s.seat, BigInt(s.endingStack) - BigInt(s.startingStack)]));
  const consistent = result.seats.every((s) => nets.get(s.seat) === BigInt(s.net));
  checks.push(check('settlement.net_is_consistent', consistent, 'net equals ending minus starting stack for every seat'));

  const stacksPositive = result.seats.every((s) => BigInt(s.endingStack) >= 0n && BigInt(s.startingStack) >= 0n);
  checks.push(check('settlement.no_negative_stacks', stacksPositive));

  return { ok: checks.every((c) => c.ok), checks };
}

/** Full verification of one published hand. */
export function verifyHandHistory(history: HandHistory, options: VerifyHandOptions = {}): HandVerdict {
  const { result, proof } = history;
  const proofVerdict = verifyRngProof(proof, options);
  const dealVerdict = proof.entropy === null ? { ok: false, checks: [check('deal.deck_available', false, 'proof not revealed')] } : verifyHandDeal(result, proof);
  const settlementVerdict = verifySettlement(result);

  let replay: HandVerdict['replay'] = null;
  const config = fromConfigJson(history.config);
  if (!options.skipReplay && config) {
    try {
      const replayed = replayHand({ result, deck: history.deck, config });
      const same = replayEquals(result, replayed);
      replay = {
        ok: same,
        detail: same
          ? `replay of ${result.actions.length} actions reproduces the published result`
          : 'replay diverged from the published result',
      };
    } catch (error) {
      replay = { ok: false, detail: `replay threw: ${(error as Error).message}` };
    }
  }

  const ok =
    proofVerdict.ok && dealVerdict.ok && settlementVerdict.ok && (replay === null || replay.ok);

  return {
    handId: result.handId,
    tableId: result.tableId,
    ok,
    proof: proofVerdict,
    deal: dealVerdict,
    replay,
    settlement: settlementVerdict,
  };
}

function replayEquals(a: HandResult, b: HandResult): boolean {
  const strip = (r: HandResult): string =>
    JSON.stringify({
      ...r,
      startedAt: 0,
      endedAt: 0,
      actions: r.actions.map((x) => ({ ...x, at: 0 })),
    });
  return strip(a) === strip(b);
}

/**
 * Verification when only the result and the proof are available (no table
 * config): everything is checked except the deterministic replay.
 */
export function verifyHand(result: HandResult, proof: RngProof, options: VerifyHandOptions = {}): HandVerdict {
  return verifyHandHistory({ result, proof, deck: proof.deck, config: null }, options);
}

/**
 * Verifies every hand in an append-only audit log (`data/hands.jsonl`).
 * Records that fail to parse are reported rather than skipped silently.
 */
export function verifyAuditLog(jsonl: string, options: VerifyHandOptions = {}): {
  total: number;
  passed: number;
  failed: number;
  results: HandVerdict[];
  malformed: { line: number; error: string }[];
} {
  const results: HandVerdict[] = [];
  const malformed: { line: number; error: string }[] = [];
  const lines = jsonl.split(/\r?\n/).filter((l) => l.trim() !== '');

  lines.forEach((line, index) => {
    try {
      const parsed = JSON.parse(line) as HandHistory;
      results.push(verifyHandHistory(parsed, options));
    } catch (error) {
      malformed.push({ line: index + 1, error: (error as Error).message });
    }
  });

  const failed = results.filter((r) => !r.ok).length;
  return { total: results.length, passed: results.length - failed, failed, results, malformed };
}

/** Human-readable rendering of a verdict, used by the CLI and the monitor. */
export function explainVerdict(verdict: HandVerdict): string {
  const lines: string[] = [];
  lines.push(`hand ${verdict.handId} (table ${verdict.tableId}): ${verdict.ok ? 'VERIFIED' : 'FAILED'}`);
  const section = (title: string, v: ProofVerification | { ok: boolean; detail: string }): void => {
    lines.push(`  ${title}: ${v.ok ? 'ok' : 'FAILED'}`);
    if ('checks' in v) {
      for (const c of v.checks) {
        lines.push(`    [${c.ok ? 'x' : ' '}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      }
    } else {
      lines.push(`    ${v.detail}`);
    }
  };
  section('proof  ', verdict.proof);
  section('deal   ', verdict.deal);
  section('settle ', verdict.settlement);
  if (verdict.replay) section('replay ', verdict.replay);
  return lines.join('\n');
}

/** Short one-line summary of what a hand paid out, for CLI output. */
export function summarizeResult(result: HandResult, config?: TableConfig | null): string {
  const board = result.board.map(cardToString).join(' ');
  const winners = result.pots
    .flatMap((p) => p.winners.map((w) => `seat ${w.seat} +${chipsToTokenString(BigInt(w.amount))}`))
    .join(', ');
  const mode = config?.mode ?? result.mode;
  return `${result.handId} [${mode}] board ${board || '(none)'} | pot ${chipsToTokenString(BigInt(result.totalPot))} | rake ${chipsToTokenString(BigInt(result.totalRake))} | ${winners}`;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export interface FetchOptions {
  api: string;
  fetchImpl?: typeof fetch;
}

/** Fetches a hand history from a running server. */
export async function fetchHand(handId: string, options: FetchOptions): Promise<HandHistory> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('no fetch implementation available');
  const base = options.api.replace(/\/+$/, '');
  const response = await doFetch(`${base}/api/v1/hands/${encodeURIComponent(handId)}`);
  if (!response.ok) throw new Error(`GET /api/v1/hands/${handId} failed: HTTP ${response.status}`);
  return (await response.json()) as HandHistory;
}

/** Fetches and verifies a hand in one call. */
export async function verifyRemoteHand(
  handId: string,
  options: FetchOptions & VerifyHandOptions,
): Promise<HandVerdict> {
  const history = await fetchHand(handId, options);
  return verifyHandHistory(history, options);
}

/** Fetches the server's own verdict, so a client can compare the two. */
export async function fetchServerVerdict(
  handId: string,
  options: FetchOptions,
): Promise<{ proof: ProofVerification; deal: ProofVerification; settlement: ProofVerification } | null> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const base = options.api.replace(/\/+$/, '');
  const response = await doFetch(`${base}/api/v1/verify/hands/${encodeURIComponent(handId)}`);
  if (!response.ok) return null;
  return (await response.json()) as { proof: ProofVerification; deal: ProofVerification; settlement: ProofVerification };
}
