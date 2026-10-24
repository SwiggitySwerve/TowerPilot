// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_FIXTURE_PATH,
  DASHBOARD_PAGES_FIXTURE_PATH,
  SYNTHETIC_ACTION_FIXTURE_PATH,
  familyHashes,
  loadJsonWithIdentity,
} from '../../../scripts/contract-fixture.mjs';
import {
  CONTRACT_INPUTS,
  PAGES_ACTIONS_DESCRIPTOR,
  familyIdentity,
  record,
} from '../../../scripts/generate-contract.mjs';

/** Approved e02b205 fixtures. Pins fail closed on changed or missing checkout bytes. */
describe('AC6 landed r17b checkout provenance', () => {
  it.each([
    [DASHBOARD_FIXTURE_PATH, '0d230c8a1d3442bcde9b3e007c6e7729bf2f2e08c91ea03a15619a07df981e73'],
    [
      DASHBOARD_PAGES_FIXTURE_PATH,
      'da4ee1e2974fb0a7c8f545aeb16304d1bfb94a139f239a0d2a5b92ff050bc864',
    ],
    [
      SYNTHETIC_ACTION_FIXTURE_PATH,
      '2696d743887d5e0edac1ff950d63cf73e32d06fa3e22d006d32b5e784cb20f7f',
    ],
  ])('pins the approved checkout bytes at %s', (file, sha256) => {
    expect(loadJsonWithIdentity(file).identity.sha256).toBe(sha256);
  });

  it('binds the actions generator directly to the checkout and the approved three families', () => {
    const input = CONTRACT_INPUTS.find(({ descriptor }) => descriptor === PAGES_ACTIONS_DESCRIPTOR);
    expect(input?.file).toBe(DASHBOARD_PAGES_FIXTURE_PATH);
    expect(familyIdentity(DASHBOARD_PAGES_FIXTURE_PATH, PAGES_ACTIONS_DESCRIPTOR)).toEqual({
      path: DASHBOARD_PAGES_FIXTURE_PATH,
      sha256: '4e4ce98b263238f6e389342fab3a985a419e95054c84ca8ead8f7387ca640fd8',
      families: {
        action_executions: '79FCD89F7BF6333FE08CAD8136A22188D5D57D49E2C3F47D9DDEBCE8EB51F3EA',
        action_executions_more: '182029CE0D48BF812E4D3453DBE7F877C9F8D663D94EA836DDDBA9BAEE066819',
        battle_actions_projection:
          '7F4933F644E7A6B07D4FF57679F0B4681987D03CA7A36C4D316D0CAEB1F6A1C5',
      },
    });
  });

  it('retains the synthetic fixture as test-only data, outside app contract generation', () => {
    const fixture = record(loadJsonWithIdentity(SYNTHETIC_ACTION_FIXTURE_PATH).fixture);
    expect(fixture['test_only']).toBe(true);
    expect(fixture['generated_by']).toBe('backend/tests/test_synthetic_action_contract.py');
    expect(CONTRACT_INPUTS.some(({ file }) => file === SYNTHETIC_ACTION_FIXTURE_PATH)).toBe(false);
    expect(familyHashes(SYNTHETIC_ACTION_FIXTURE_PATH)).toEqual({
      synthetic_action: '51E6F61470687F19A322E6A623EEA238B219FF4A52A73C5E24DBE11565B2CD7C',
    });
    const cases = record(fixture['cases']);
    expect(Object.keys(cases)).toEqual(['synthetic_action']);
    expect(Object.keys(record(cases['synthetic_action']))).toHaveLength(24);
  });
});
