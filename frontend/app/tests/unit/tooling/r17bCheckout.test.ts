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
    [DASHBOARD_FIXTURE_PATH, '17002fa1fdda1a8b32048978dfcc9e6d4cac8f0163ffcc83cf11d2534dde975e'],
    [
      DASHBOARD_PAGES_FIXTURE_PATH,
      '9da4c075711141cdef553891056dbf8bb4364f9c4f55de7b48c6d42705799512',
    ],
    [
      SYNTHETIC_ACTION_FIXTURE_PATH,
      'f6ef2c6360f6b053302c8c3b5abae588c666d2e326a535c1a2a7c19d5a2b838b',
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
      synthetic_action: 'F661EE52D80D60FDAD302A34795E22A0D812A7C9EE1274A7C134584A54D6E1BD',
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
