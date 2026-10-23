// @ts-check
/**
 * Copies the A2-7 action families of the r17b CANDIDATE pages fixture unchanged into
 * e2e/r17b-candidate-samples.json, with the candidate's path, SHA-256 and family hashes, so the
 * actions contract (scripts/generate-contract.mjs PAGES_ACTIONS_DESCRIPTOR) binds to recordings
 * the backend has published but not landed. Each family is copied as its exact source text, so
 * its family hash (contract-fixture.mjs familyHashes) is the candidate's. Run from frontend/app:
 * node e2e/r17b-candidate-samples.mjs
 * Once r17b lands in backend/tests/fixtures/dashboard_contract_pages_v1.json the descriptor
 * moves back to that file and this snapshot is deleted (tests/tooling/r17bCandidate.test.ts).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { familyHashes } from '../scripts/contract-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
export const R17B_CANDIDATE_NAME =
  'backend/logs/reviews/roadmap-item6-r17b/candidate-fixtures/dashboard_contract_pages_v1.json';
export const R17B_SAMPLES_PATH = path.join(HERE, 'r17b-candidate-samples.json');
export const R17B_FAMILIES = [
  'action_executions',
  'action_executions_more',
  'battle_actions_projection',
];

/** The exact source text of `"<family>": {...}` under `cases` (one-space indented JSON). */
function familyText(/** @type {string} */ text, /** @type {string} */ family) {
  const lines = text.split('\n');
  const start = lines.indexOf(`  ${JSON.stringify(family)}: {`);
  if (start < 0) throw new Error(`No family ${family} in the candidate`);
  const end = lines.findIndex((line, i) => i > start && /^ {2}\}/.test(line));
  if (end < 0) throw new Error(`Unterminated family ${family}`);
  return [...lines.slice(start, end), '  }'].join('\n');
}

function main() {
  const source = path.join(REPO, R17B_CANDIDATE_NAME);
  const bytes = readFileSync(source);
  const text = bytes.toString('utf8').replace(/\r\n/g, '\n');
  /** @type {unknown} */
  const parsed = JSON.parse(text);
  /** @type {unknown} */
  const allNotes = Reflect.get(Object(parsed), 'notes');
  const hashes = familyHashes(source);
  const families = Object.fromEntries(R17B_FAMILIES.map((family) => [family, hashes[family]]));
  const notes = Object.fromEntries(
    R17B_FAMILIES.map((family) => [family, Reflect.get(Object(allNotes), family)]),
  );
  const document = [
    '{',
    ' "cases": {',
    R17B_FAMILIES.map((family) => familyText(text, family)).join(',\n'),
    ' },',
    ` "generated_by": ${JSON.stringify('frontend/app/e2e/r17b-candidate-samples.mjs')},`,
    ` "notes": ${JSON.stringify(notes)},`,
    ` "source": ${JSON.stringify({
      path: R17B_CANDIDATE_NAME,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      families,
    })},`,
    ' "version": 1',
    '}',
    '',
  ].join('\n');
  writeFileSync(R17B_SAMPLES_PATH, document);
  const copied = familyHashes(R17B_SAMPLES_PATH);
  for (const family of R17B_FAMILIES)
    if (copied[family] !== families[family]) throw new Error(`${family} changed in the copy`);
  console.log(`Wrote ${R17B_SAMPLES_PATH}\n${JSON.stringify(families, null, 1)}`);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
