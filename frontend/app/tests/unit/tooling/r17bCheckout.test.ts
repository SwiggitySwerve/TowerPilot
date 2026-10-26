// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
import { REPO } from '../../support/paths.ts';

/**
 * Approved e02b205 dashboard fixtures and the r17c-landed (b23bf8c) synthetic fixture.
 * Pins fail closed on changed or missing checkout bytes.
 */
describe('AC6 landed r17b checkout provenance', () => {
  it.each([
    [DASHBOARD_FIXTURE_PATH, 'a1adee857b2810076eb125970c5dd7f0e0d5439cb16e3e3560ef8c46e593c66c'],
    [
      DASHBOARD_PAGES_FIXTURE_PATH,
      'f587f912c6b8c40a2103ceba828b6338b03d48c8400dc0e22dabd3fe02a962ac',
    ],
    [
      SYNTHETIC_ACTION_FIXTURE_PATH,
      'dcbc547a5f8fec8f69a277f92a3543cdbe3efea4ca35b2aa4f4b52d94603ceb1',
    ],
  ])('pins the approved checkout bytes at %s', (file, sha256) => {
    expect(loadJsonWithIdentity(file).identity.sha256).toBe(sha256);
  });

  it('binds the actions generator directly to the checkout and the approved three families', () => {
    const input = CONTRACT_INPUTS.find(({ descriptor }) => descriptor === PAGES_ACTIONS_DESCRIPTOR);
    expect(input?.file).toBe(DASHBOARD_PAGES_FIXTURE_PATH);
    expect(familyIdentity(DASHBOARD_PAGES_FIXTURE_PATH, PAGES_ACTIONS_DESCRIPTOR)).toEqual({
      path: DASHBOARD_PAGES_FIXTURE_PATH,
      sha256: 'f973065032c6e210adc16bcf84b912503ab3383189c5632509ff8ed047439d4f',
      families: {
        action_executions: '271D75FE6AADB6E706D10C92A97E96E7836231742247ACB2D06ACABE22117558',
        action_executions_more: '10145821C7FA9C53E591DD2667477993DCB6730CDCF7FE2E5600F4B13FF24070',
        battle_actions_projection:
          '723DF823ED95BAD892C6801063F53EE0A09E227D86B2E93B0C2A8586EE7E910A',
      },
    });
  });

  it('retains the synthetic fixture as test-only data, outside app contract generation', () => {
    const fixture = record(loadJsonWithIdentity(SYNTHETIC_ACTION_FIXTURE_PATH).fixture);
    expect(fixture['test_only']).toBe(true);
    expect(fixture['generated_by']).toBe('backend/tests/test_synthetic_action_contract.py');
    expect(CONTRACT_INPUTS.some(({ file }) => file === SYNTHETIC_ACTION_FIXTURE_PATH)).toBe(false);
    expect(familyHashes(SYNTHETIC_ACTION_FIXTURE_PATH)).toEqual({
      synthetic_action: '703CDEB851C53385E10D89EDAE6997231EBBF3A41D479CA9AB890BCA740BCD06',
    });
    const cases = record(fixture['cases']);
    expect(Object.keys(cases)).toEqual(['synthetic_action']);
    expect(Object.keys(record(cases['synthetic_action']))).toHaveLength(33);
  });

  it('AC7 the synthetic action id appears in no non-test frontend file', () => {
    const fixture = record(loadJsonWithIdentity(SYNTHETIC_ACTION_FIXTURE_PATH).fixture);
    const cases = record(record(fixture['cases'])['synthetic_action']);
    const request = record(record(cases['synthetic_run_now_accepted'])['request']);
    const token = record(request['body'])['action'];
    expect(typeof token).toBe('string');
    const id = String(token).split('@')[0];
    expect(id).toBeTruthy();
    // Includes untracked source, honors .gitignore (builds and dependencies are not source).
    const listFiles = (...options: string[]) =>
      execFileSync('git', ['ls-files', '-z', ...options, 'frontend'], {
        cwd: REPO,
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean);
    // A file the working tree already deleted (a pruned generated module) is still listed as
    // cached until its removal is staged; it holds no source, so it is not read.
    const deleted = new Set(listFiles('--deleted'));
    const files = listFiles('--cached', '--others', '--exclude-standard').filter(
      (file) => !deleted.has(file),
    );
    const found = files.filter(
      (file) =>
        !/(?:^|\/)(?:tests|e2e)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) &&
        readFileSync(path.join(REPO, file)).includes(String(id)),
    );
    expect(found).toEqual([]);
  });
});
