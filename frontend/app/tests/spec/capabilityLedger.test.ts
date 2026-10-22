// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { capabilityFailures, WANTED_BASELINE } from './ledger.ts';
import { SPEC } from './specData.ts';

/**
 * Spec 9 item 1: every Wanted-baseline row of section 4 (74, section 4.1) has
 * a passing test whose title starts with its F-id. This file holds the list
 * and checks it against the spec's own table; whether each id has a PASSING
 * test is judged at the end of the same run by tests/spec/ledgerReporter.ts
 * (it judges only runs that include this file).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function specBaselineIds(): string[] {
  const text = readFileSync(path.join(ROOT, SPEC.name), 'utf8');
  return text
    .split('\n')
    .filter((line) => /^\| F-\d{3} \|/u.test(line))
    .filter((line) => line.split('|')[4]?.trim() === 'Wanted-baseline')
    .map((line) => line.split('|')[1]?.trim() ?? '');
}

describe('the capability ledger of spec section 4', () => {
  it('lists exactly the 74 Wanted-baseline rows of the spec, in order', () => {
    expect(WANTED_BASELINE).toHaveLength(74);
    expect(WANTED_BASELINE).toEqual(specBaselineIds());
  });

  it('the proof rule: an id is proved only by a title that starts with it (planted errors)', () => {
    expect(capabilityFailures(['F-999'], ['a test about F-999', 'F-9990: other'])).toEqual([
      'F-999: no passing test titled "F-999: ..."',
    ]);
    expect(capabilityFailures(['F-999'], ['F-999: proves it'])).toEqual([]);
    expect(capabilityFailures(['F-999'], ['F-999 proves it'])).toEqual([]);
    expect(capabilityFailures(['F-999'], [])).toHaveLength(1);
  });
});
