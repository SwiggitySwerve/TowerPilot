// @vitest-environment node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_PAGES_FIXTURE_PATH,
  familyHashes,
  loadJsonWithIdentity,
} from '../../scripts/contract-fixture.mjs';
import { R17B_SAMPLES_FILE } from '../../scripts/generate-contract.mjs';
import { R17B_CANDIDATE_NAME, R17B_FAMILIES } from '../../e2e/r17b-candidate-samples.mjs';

/**
 * A2-7 R0 binds the actions contract to the r17b CANDIDATE recordings through an unchanged copy
 * of three families (e2e/r17b-candidate-samples.json). The copy must hash as the candidate's
 * families do, and the checkout pages fixture must hold the same families once r17b lands.
 */
const samples = loadJsonWithIdentity(R17B_SAMPLES_FILE).fixture;
const source: unknown = Reflect.get(Object(samples), 'source');
const recorded: unknown = Reflect.get(Object(source), 'families');
const copied = familyHashes(R17B_SAMPLES_FILE);
const candidatePath = path.resolve(
  path.dirname(DASHBOARD_PAGES_FIXTURE_PATH),
  '../../..',
  R17B_CANDIDATE_NAME,
);

describe('AC6 r17b candidate provenance', () => {
  it('AC6 the snapshot names the candidate file, its SHA-256 and exactly the three families', () => {
    expect(Reflect.get(Object(source), 'path')).toBe(R17B_CANDIDATE_NAME);
    expect(Reflect.get(Object(source), 'sha256')).toBe(
      '4523354e95a7b860a1c2740aff79f4e41107dc4562704a9462eb3fcd5441739c',
    );
    expect(Object.keys(copied).sort()).toEqual([...R17B_FAMILIES].sort());
    expect(
      typeof recorded === 'object' && recorded !== null ? Object.keys(recorded).sort() : [],
    ).toEqual([...R17B_FAMILIES].sort());
  });

  it.each(R17B_FAMILIES)('AC6 family %s hashes as the candidate recorded it', (family) => {
    expect(copied[family]).toBe(Reflect.get(Object(recorded), family));
  });

  it.runIf(existsSync(candidatePath)).each(R17B_FAMILIES)(
    'AC6 family %s equals the candidate file while the candidate is present',
    (family) => {
      expect(loadJsonWithIdentity(candidatePath).identity.sha256).toBe(
        Reflect.get(Object(source), 'sha256'),
      );
      expect(familyHashes(candidatePath)[family]).toBe(copied[family]);
    },
  );

  it.each(R17B_FAMILIES)(
    'AC6 family %s equals the checkout pages fixture once r17b lands there',
    (family) => {
      const checkout = familyHashes(DASHBOARD_PAGES_FIXTURE_PATH);
      // r17b's landing is marked by its new family; before then the checkout holds r17a.
      if (!Object.hasOwn(checkout, 'action_executions_more')) {
        expect(checkout['action_executions_more']).toBeUndefined();
        return;
      }
      expect(checkout[family]).toBe(copied[family]);
    },
  );
});
