/**
 * Repairs UTF-8 text that was round-tripped through CP1252 (PowerShell's default
 * encoding), which turns "–" into "â€“" and "§" into "Â§".
 *
 * Usage: npx tsx scripts/fix-encoding.ts [--check]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const MOJIBAKE: [RegExp, string][] = [
  [/â€“/g, '–'],
  [/â€”/g, '—'],
  [/â€˜/g, '‘'],
  [/â€™/g, '’'],
  [/â€œ/g, '“'],
  [/â€\x9d/g, '”'],
  [/â€¦/g, '…'],
  [/â‚¬/g, '€'],
  [/Â§/g, '§'],
  [/Â·/g, '·'],
  [/Â°/g, '°'],
  [/Â«/g, '«'],
  [/Â»/g, '»'],
  [/Ã©/g, 'é'],
  [/Ã¨/g, 'è'],
  [/Ã¡/g, 'á'],
  [/Ã¼/g, 'ü'],
  [/Ã¶/g, 'ö'],
  [/Ã±/g, 'ñ'],
  [/â‰¥/g, '≥'],
  [/â‰¤/g, '≤'],
  [/â†’/g, '→'],
  [/âˆ’/g, '−'],
  [/âˆ—/g, '∗'],
  [/Ã—/g, '×'],
];

const TEXT_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.sol', '.yml', '.yaml', '.txt', '.css', '.html'];

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter((f) => f !== '' && TEXT_EXTENSIONS.some((ext) => f.endsWith(ext)));

const checkOnly = process.argv.includes('--check');
let repaired = 0;
const problems: string[] = [];

for (const file of files) {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\uFFFD')) {
    problems.push(`${file}: contains U+FFFD replacement characters (read as UTF-8 failed)`);
    continue;
  }
  let fixed = text;
  const hits: string[] = [];
  for (const [pattern, replacement] of MOJIBAKE) {
    if (pattern.test(fixed)) {
      hits.push(String(pattern));
      fixed = fixed.replace(pattern, replacement);
    }
  }
  if (fixed === text) continue;

  if (checkOnly) {
    problems.push(`${file}: mojibake (${hits.join(', ')})`);
    continue;
  }
  writeFileSync(file, fixed, 'utf8');
  repaired += 1;
  console.log(`repaired ${file} (${hits.join(', ')})`);
}

console.log(`\nscanned ${files.length} text files; ${checkOnly ? problems.length : repaired} with encoding damage`);
for (const p of problems) console.log(`  ${p}`);
process.exit(problems.length > 0 ? 1 : 0);
