// @ts-check
/**
 * The recorded takeover cases (`dashboard_contract_takeover_v1`), as the tests read them:
 * `<scenario>.<case>`, a fresh copy of the recorded `{status, request, body}`. Nothing here writes
 * a server answer; a test that must change one says so.
 */
import { loadJsonWithIdentity } from '../../scripts/contract-fixture.mjs';
import { TAKEOVER_FIXTURE_PATH } from '../../scripts/generate-takeover-contract.mjs';

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected a plain object in the takeover fixture');
  return Object.fromEntries(Object.entries(value));
}

/** @type {Record<string, unknown> | undefined} */
let scenarios;

function loaded() {
  scenarios ??= record(record(loadJsonWithIdentity(TAKEOVER_FIXTURE_PATH).fixture)['scenarios']);
  return scenarios;
}

/** Every recorded case name as `<scenario>.<case>`. */
export function takeoverCaseNames() {
  return Object.entries(loaded()).flatMap(([scenario, cases]) =>
    Object.keys(record(cases)).map((name) => `${scenario}.${name}`),
  );
}

/**
 * A recorded case: its request (POST cases), status and a fresh copy of its response body.
 * @param {string} path `<scenario>.<case>`
 */
export function takeoverCase(path) {
  const [scenario = '', name = ''] = path.split('.');
  const row = record(record(loaded()[scenario] ?? {})[name]);
  if (typeof row['status'] !== 'number') throw new Error(`Unknown takeover case ${path}`);
  return {
    status: row['status'],
    request: row['request'] === undefined ? undefined : structuredClone(row['request']),
    body: structuredClone(record(row['response'])),
  };
}
