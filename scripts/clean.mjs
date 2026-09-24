/** Removes build output and Hardhat artifacts. Keeps node_modules and data/. */

import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const targets = [
  'packages/shared/dist',
  'packages/engine/dist',
  'packages/verifier/dist',
  'packages/server/dist',
  'contracts/artifacts',
  'contracts/cache',
  'coverage',
];

for (const target of targets) {
  const path = join(process.cwd(), target);
  if (!existsSync(path)) continue;
  rmSync(path, { recursive: true, force: true });
  console.log(`removed ${target}`);
}

console.log('clean complete (node_modules and data/ were left alone)');
