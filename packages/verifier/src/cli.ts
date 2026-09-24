#!/usr/bin/env node
/**
 * `llmpoker-verify` — verify a shuffle proof, a hand history or a whole audit log
 * without trusting the server that produced it (FR-6.3, acceptance criterion #4).
 *
 *   llmpoker-verify hand hand_abc --api https://play.example
 *   llmpoker-verify proof --file proof.json
 *   llmpoker-verify log --file data/hands.jsonl
 *   llmpoker-verify shuffle --seed 0x… --anchor 0x…
 *   llmpoker-verify commitment --seed 0x… --nonce 42
 *
 * Exit code 0 means "verified"; 1 means "failed verification"; 2 means "bad usage".
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  type HandHistory,
  type RngProof,
  bytesToHex,
  cardToString,
  commitmentHex,
  deckFromReveal,
  entropyHex,
  verifyRngProof,
} from '@llmpoker/shared';
import {
  explainVerdict,
  summarizeResult,
  verifyAuditLog,
  verifyHandHistory,
  verifyRemoteHand,
} from './index.js';

const USAGE = `llmpoker-verify — LLM Poker Arena fairness verifier

Usage:
  llmpoker-verify hand <handId> --api <url> [--json] [--no-reveal-required]
  llmpoker-verify proof --file <path> [--json]
  llmpoker-verify log --file <path> [--json]
  llmpoker-verify shuffle --seed <0x…32 bytes> --anchor <0x…32 bytes> [--json]
  llmpoker-verify commitment --seed <0x…32 bytes> --nonce <uint256>

Options:
  --json                 machine-readable output
  --no-reveal-required   accept a proof whose reveal has not happened yet
  -h, --help             show this help

Exit codes: 0 verified · 1 failed verification · 2 usage/IO error`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function print(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read ${path}: ${(error as Error).message}`);
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      api: { type: 'string' },
      file: { type: 'string' },
      seed: { type: 'string' },
      anchor: { type: 'string' },
      nonce: { type: 'string' },
      json: { type: 'boolean', default: false },
      'no-reveal-required': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const command = positionals[0];
  if (values.help || command === undefined) {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined && !values.help ? 2 : 0;
  }

  const requireReveal = !values['no-reveal-required'];

  switch (command) {
    case 'hand': {
      const handId = positionals[1];
      if (!handId) fail('usage: llmpoker-verify hand <handId> --api <url>');
      if (!values.api) fail('--api <url> is required');
      const verdict = await verifyRemoteHand(handId, { api: values.api, requireReveal });
      if (values.json) print(verdict);
      else process.stdout.write(`${explainVerdict(verdict)}\n`);
      return verdict.ok ? 0 : 1;
    }

    case 'proof': {
      if (!values.file) fail('--file <path> is required');
      const parsed = readJsonFile(values.file) as RngProof | HandHistory;
      const proof = 'proof' in parsed ? parsed.proof : parsed;
      const verdict = verifyRngProof(proof, { requireReveal });
      if (values.json) print(verdict);
      else {
        process.stdout.write(`proof for hand ${proof.handId}: ${verdict.ok ? 'VERIFIED' : 'FAILED'}\n`);
        for (const c of verdict.checks) {
          process.stdout.write(`  [${c.ok ? 'x' : ' '}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}\n`);
        }
      }
      return verdict.ok ? 0 : 1;
    }

    case 'log': {
      if (!values.file) fail('--file <path> is required');
      const text = (() => {
        try {
          return readFileSync(values.file, 'utf8');
        } catch (error) {
          return fail(`cannot read ${values.file}: ${(error as Error).message}`);
        }
      })();
      const summary = verifyAuditLog(text, { requireReveal });
      if (values.json) {
        print({ total: summary.total, passed: summary.passed, failed: summary.failed, malformed: summary.malformed });
      } else {
        process.stdout.write(`audit log: ${summary.passed}/${summary.total} hands verified, ${summary.failed} failed\n`);
        for (const bad of summary.results.filter((r) => !r.ok)) {
          process.stdout.write(`  FAILED ${bad.handId}: ${describeFailures(bad)}\n`);
        }
        for (const m of summary.malformed) process.stdout.write(`  MALFORMED line ${m.line}: ${m.error}\n`);
      }
      return summary.failed === 0 && summary.malformed.length === 0 ? 0 : 1;
    }

    case 'shuffle': {
      if (!values.seed || !values.anchor) fail('--seed and --anchor are required');
      const deck = deckFromReveal(values.seed, values.anchor);
      const entropy = entropyHex(values.seed, values.anchor);
      const cards = deck.map(cardToString);
      if (values.json) print({ entropy, deck, cards });
      else {
        process.stdout.write(`entropy: ${entropy}\ndeck: ${deck.join(',')}\ncards: ${cards.join(' ')}\n`);
      }
      return 0;
    }

    case 'commitment': {
      if (!values.seed || !values.nonce) fail('--seed and --nonce are required');
      const commitment = commitmentHex(values.seed, BigInt(values.nonce));
      if (values.json) print({ commitment, seed: values.seed, nonce: values.nonce });
      else process.stdout.write(`${commitment}\n`);
      return 0;
    }

    default:
      process.stderr.write(`unknown command: ${command}\n${USAGE}\n`);
      return 2;
  }
}

function describeFailures(verdict: ReturnType<typeof verifyHandHistory>): string {
  const failed = [...verdict.proof.checks, ...verdict.deal.checks, ...verdict.settlement.checks].filter((c) => !c.ok);
  const parts = failed.map((c) => c.name);
  if (verdict.replay && !verdict.replay.ok) parts.push('replay');
  return parts.join(', ');
}

export { verifyHandHistory, summarizeResult, bytesToHex };

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exit(2);
  });
