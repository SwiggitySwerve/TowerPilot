import { describe, expect, it } from 'vitest';
import { ENDPOINTS, parseAnswer } from '../../../src/api/wire.ts';
import {
  takeoverLaunchAnswerSchema,
  takeoverPreviewAnswerSchema,
} from '../../../src/contract/takeover.ts';
import {
  CASE_FAMILIES,
  TAKEOVER_FIXTURE_PATH,
  UNBOUND_CASES,
  generateTakeover,
  takeoverCases,
} from '../../../scripts/generate-takeover-contract.mjs';
import { loadJsonWithIdentity } from '../../../scripts/contract-fixture.mjs';
import { takeoverCaseNames, takeoverRecorded } from '../../support/takeoverFixture.ts';

const SCHEMAS = {
  takeover_preview: takeoverPreviewAnswerSchema,
  takeover_launch: takeoverLaunchAnswerSchema,
} as const;

const ENDPOINT_OF = { takeover_preview: 'takeoverPreview', takeover_launch: 'takeover' } as const;

const names = takeoverCaseNames();
const bound = names.filter((path) => path in CASE_FAMILIES);
const fixture = loadJsonWithIdentity(TAKEOVER_FIXTURE_PATH).fixture;

describe('the takeover contract (backend/tests/fixtures/dashboard_contract_takeover_v1.json)', () => {
  it('names every recorded case once: bound to a route family or listed as another route', () => {
    expect(names.filter((path) => path in CASE_FAMILIES && path in UNBOUND_CASES)).toEqual([]);
    expect(names.filter((path) => !(path in CASE_FAMILIES) && !(path in UNBOUND_CASES))).toEqual(
      [],
    );
    expect(Object.keys({ ...CASE_FAMILIES, ...UNBOUND_CASES }).sort()).toEqual([...names].sort());
  });

  it('the generated module is the generator output for this fixture (no drift)', async () => {
    expect(Object.keys(takeoverCases(fixture).cases).sort()).toEqual(Object.keys(SCHEMAS).sort());
    await expect(generateTakeover(true)).resolves.toBeUndefined();
  }, 60_000);

  it('a case the generator does not name is an error, never silently skipped', () => {
    const copy = structuredClone(fixture) as { scenarios: Record<string, Record<string, unknown>> };
    const first = Object.values(copy.scenarios)[0] ?? {};
    first['a_case_nobody_bound'] = { status: 200, response: {} };
    expect(() => takeoverCases(copy)).toThrow(/a_case_nobody_bound/u);
  });

  it.each(bound)('%s parses exactly against its family and its endpoint', (path) => {
    const family = CASE_FAMILIES[path] as keyof typeof SCHEMAS;
    const recorded = takeoverRecorded(path);
    expect(
      SCHEMAS[family].safeParse({ status: recorded.status, body: recorded.body }).success,
    ).toBe(true);
    const parsed = parseAnswer(
      ENDPOINTS[ENDPOINT_OF[family]],
      recorded.status,
      JSON.stringify(recorded.body),
    );
    expect(parsed.contract).toBe('exact');
    expect(parsed.issues.filter((issue) => issue.startsWith('dropped:'))).toEqual([]);
  });

  it('a changed field is drift, not a silently accepted answer', () => {
    const recorded = takeoverRecorded('preview_free.run_preview_nothing_owns_the_emulator');
    const body = { ...recorded.body, extra_member: true };
    expect(takeoverPreviewAnswerSchema.safeParse({ status: 200, body }).success).toBe(false);
    expect(parseAnswer(ENDPOINTS.takeoverPreview, 200, JSON.stringify(body)).contract).toBe(
      'drift',
    );
  });
});
