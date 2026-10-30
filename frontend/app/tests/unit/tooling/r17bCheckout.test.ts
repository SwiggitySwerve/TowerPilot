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
    [DASHBOARD_FIXTURE_PATH, 'e1fe970f063ba915a6de1ae1ba2fe99aa79e4b143790057c834926728f6a7979'],
    [
      DASHBOARD_PAGES_FIXTURE_PATH,
      '22176e4df054d799e282a4b52ff863a87a7dc5e89c4218a76c56192b955e6f67',
    ],
    [
      SYNTHETIC_ACTION_FIXTURE_PATH,
      'fd5327bb2ce9ef45b7e30e2d21ddb23550888ea63156a75cc75e122bd3b7cf14',
    ],
  ])('pins the approved checkout bytes at %s', (file, sha256) => {
    expect(loadJsonWithIdentity(file).identity.sha256).toBe(sha256);
  });

  it('binds the actions generator directly to the checkout and the approved three families', () => {
    const input = CONTRACT_INPUTS.find(({ descriptor }) => descriptor === PAGES_ACTIONS_DESCRIPTOR);
    expect(input?.file).toBe(DASHBOARD_PAGES_FIXTURE_PATH);
    expect(familyIdentity(DASHBOARD_PAGES_FIXTURE_PATH, PAGES_ACTIONS_DESCRIPTOR)).toEqual({
      path: DASHBOARD_PAGES_FIXTURE_PATH,
      sha256: 'e909ffc056a72289f4f26c1f5136b425f82decc724f02718577c13f12a4aa1c0',
      families: {
        action_executions: '32EE60CB5317F756E846C3182600B055DA7CD48B680327F4392430B5F69FF345',
        action_executions_more: '090C193A1159084FD28032FFD9EC0F72E673F0D3264AD900C3153749DA23885C',
        battle_actions_projection:
          'CA68FE30F3463847A682329EB65889BEB6F3956E7D08AEF624171F7EF48B18A8',
      },
    });
  });

  it('retains the synthetic fixture as test-only data, outside app contract generation', () => {
    const fixture = record(loadJsonWithIdentity(SYNTHETIC_ACTION_FIXTURE_PATH).fixture);
    expect(fixture['test_only']).toBe(true);
    expect(fixture['generated_by']).toBe('backend/tests/test_synthetic_action_contract.py');
    expect(CONTRACT_INPUTS.some(({ file }) => file === SYNTHETIC_ACTION_FIXTURE_PATH)).toBe(false);
    expect(familyHashes(SYNTHETIC_ACTION_FIXTURE_PATH)).toEqual({
      synthetic_action: '426941C31BD0DBE3F3944A43F7FA0BEC2B30B2D7D52F54C1E6FCEE84A6E0638B',
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
