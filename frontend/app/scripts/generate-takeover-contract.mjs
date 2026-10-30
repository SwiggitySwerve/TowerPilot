// @ts-check
/**
 * Strict schemas for the two takeover routes, from the recorded fixture
 * (backend/tests/fixtures/dashboard_contract_takeover_v1.json, written by the backend's
 * tests/recording/dashboard_contract_cases_takeover.py).
 *
 * Its layout is `scenarios -> scenario -> case -> {request, status, response}`, not the
 * `cases.<family>` layout of the pages fixture, so this script reads each recorded case once, puts
 * it in the family of its route by NAME and hands the existing generator the same `{status, body}`
 * samples it reads for every other family. A case named in neither CASE_FAMILIES nor UNBOUND_CASES
 * is an error, so a case the backend adds is bound on purpose. The module is bound to the hashes
 * of the two families (an unrelated case added later changes nothing here, a changed one is drift).
 *
 * Nothing in this file writes or invents a server answer.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { generatedFile, generateModule, writeGenerated } from './generate-contract.mjs';
import { loadJsonWithIdentity } from './contract-fixture.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TAKEOVER_FIXTURE_NAME = 'backend/tests/fixtures/dashboard_contract_takeover_v1.json';
export const TAKEOVER_FIXTURE_PATH = path.resolve(APP, '../..', TAKEOVER_FIXTURE_NAME);

/** The two routes of the fixture and the schema each one gets. */
export const TAKEOVER_FAMILIES = /** @type {const} */ ([
  ['takeover_preview', 'TakeoverPreviewAnswer', 'takeoverPreviewAnswerSchema'],
  ['takeover_launch', 'TakeoverLaunchAnswer', 'takeoverLaunchAnswerSchema'],
]);

/**
 * `<scenario>.<case>` to family: GET /api/takeover/preview, and POST /api/control
 * `action: "takeover"` (accepted, replayed and every refusal).
 * @type {Readonly<Record<string, string>>}
 */
export const CASE_FAMILIES = {
  'preview_free.run_list': 'takeover_preview',
  'preview_free.run_preview_nothing_owns_the_emulator': 'takeover_preview',
  'preview_collector.run_preview_collector_owns_the_emulator': 'takeover_preview',
  'preview_blocked.run_list_with_an_incompatible_run': 'takeover_preview',
  'preview_blocked.run_preview_another_runner_owns_the_emulator': 'takeover_preview',
  'preview_blocked.run_preview_calibration_needed': 'takeover_preview',
  'preview_blocked.run_preview_incompatible': 'takeover_preview',
  'preview_blocked.run_preview_tournament_recognition_missing': 'takeover_preview',
  'preview_blocked.run_preview_unknown_run': 'takeover_preview',
  'launch_free.accepted_nothing_owns_the_emulator': 'takeover_launch',
  'launch_free.failed_after_accept_read_back_by_the_same_request': 'takeover_launch',
  'launch_free.identical_retry_replays_the_receipt': 'takeover_launch',
  'launch_free.same_key_changed_request_is_uncoded_409': 'takeover_launch',
  'launch_collector.accepted_collector_transferred': 'takeover_launch',
  'refusals.action_lock': 'takeover_launch',
  'refusals.calibration_needed': 'takeover_launch',
  'refusals.context_changed': 'takeover_launch',
  'refusals.device_owned_by_another_runner': 'takeover_launch',
  'refusals.invalid_attestation': 'takeover_launch',
  'refusals.invalid_missing_attach': 'takeover_launch',
  'refusals.invalid_reserved_field': 'takeover_launch',
  'refusals.invalid_unknown_field': 'takeover_launch',
  'refusals.invalid_unknown_run': 'takeover_launch',
  'refusals.policy_changed': 'takeover_launch',
  'refusals.takeover_not_compatible': 'takeover_launch',
  'refusals.tournament_recognition_missing': 'takeover_launch',
  'refusals_collector.attach_battle_changed': 'takeover_launch',
  'refusals_collector.collector_stopping': 'takeover_launch',
};

/**
 * Recorded cases of routes other than the two above (battle and operation reads, Stop, a live
 * control) or test-harness projections of a replayed receipt; the value says which.
 * @type {Readonly<Record<string, string>>}
 */
export const UNBOUND_CASES = {
  'attached_battle.battle_after_stop_is_interrupted_and_the_game_battle_is_untouched':
    'GET /api/battles/active',
  'attached_battle.live_control_recorded_but_unreadable_is_a_500_outcome_unknown':
    'POST live-controls',
  'attached_battle.operation_after_stop': 'GET /api/operations/<id>',
  'attached_battle.retrying_the_takeover_after_stop_replays_the_receipt':
    'harness projection of the replayed receipt (no operation member)',
  'attached_battle.second_control_while_the_first_is_pending_is_an_uncoded_409':
    'POST live-controls',
  'attached_battle.stop_automation': 'POST cancel',
  'attached_battle.the_same_request_reads_the_recorded_command_back_accepted': 'POST live-controls',
  'launch_collector.battle_after_taking_over_the_collectors_battle': 'GET /api/battles/active',
  'launch_collector.battle_with_the_later_wave_but_no_entry_observation': 'GET /api/battles/active',
  'launch_free.failed_after_accept_read_by_id': 'GET /api/operations/<id>',
  'real_worker.battle_read_after_the_real_worker_entered': 'GET /api/battles/active',
  'real_worker.collector_record_after_the_real_worker_entered': 'the collector ledger record',
  'real_worker_refused.no_battle_after_the_real_worker_refused': 'GET /api/battles/active',
  'real_worker_refused.operation_after_the_real_worker_refused': 'GET /api/operations/<id>',
  'real_worker_refused.same_request_reads_the_failed_operation_back':
    'harness projection of the replayed receipt (no operation member)',
};

/** @param {unknown} value @returns {Record<string, unknown>} */
function plain(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a plain object in the takeover fixture');
  }
  return Object.fromEntries(Object.entries(value));
}

/** @param {unknown} value @returns {string} canonical JSON: keys sorted at every depth. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The fixture as `{version, cases: {<family>: {<case>: {status, body}}}}`.
 * @param {unknown} fixture
 */
export function takeoverCases(fixture) {
  const root = plain(fixture);
  if (root['schema'] !== 'takeover_contract_v1' || root['version'] !== 1) {
    throw new Error('Not the takeover contract fixture (schema takeover_contract_v1, version 1)');
  }
  /** @type {Record<string, Record<string, { status: unknown, body: unknown }>>} */
  const cases = Object.fromEntries(TAKEOVER_FAMILIES.map(([family]) => [family, {}]));
  /** @type {string[]} */
  const unnamed = [];
  for (const [scenario, recorded] of Object.entries(plain(root['scenarios']))) {
    for (const [name, sample] of Object.entries(plain(recorded))) {
      const key = `${scenario}.${name}`;
      if (key in UNBOUND_CASES) continue;
      const family = CASE_FAMILIES[key];
      const target = family === undefined ? undefined : cases[family];
      if (target === undefined) {
        unnamed.push(key);
        continue;
      }
      const row = plain(sample);
      target[key] = { status: row['status'], body: row['response'] };
    }
  }
  if (unnamed.length > 0) {
    throw new Error(
      `Takeover cases named in neither CASE_FAMILIES nor UNBOUND_CASES of scripts/generate-takeover-contract.mjs: ${unnamed.join(', ')}`,
    );
  }
  return { version: root['version'], cases };
}

export const TAKEOVER_DESCRIPTOR = {
  name: 'dashboard_contract_takeover_v1',
  boundTo: /** @type {const} */ ('families'),
  families: TAKEOVER_FAMILIES.map(([family, name]) => ({
    key: `cases.${family}`,
    name,
    rawPath: 'answer',
    pick: ['status', 'body'],
  })),
};

/**
 * Per-family identity: SHA-256 of each family's canonical samples, then of the sorted lines.
 * @param {string} file
 * @param {{ cases: Record<string, Record<string, unknown>> }} cases
 */
export function takeoverIdentity(file, cases) {
  /** @type {Record<string, string>} */
  const families = {};
  for (const [family, samples] of Object.entries(cases.cases)) {
    families[family] = createHash('sha256')
      .update(canonical(samples), 'utf8')
      .digest('hex')
      .toUpperCase();
  }
  const lines = Object.entries(families)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([family, hash]) => `${family} ${hash}`);
  return {
    path: file,
    sha256: createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex'),
    families,
  };
}

export async function generateTakeover(check = false, file = TAKEOVER_FIXTURE_PATH) {
  const loaded = loadJsonWithIdentity(file);
  const cases = takeoverCases(loaded.fixture);
  const identity = takeoverIdentity(file, cases);
  const module = path.basename(generatedFile(identity, TAKEOVER_DESCRIPTOR));
  const folder = path.join(APP, 'src/contract/generated/takeover');
  const generated = await generateModule(cases, identity, TAKEOVER_DESCRIPTOR);
  writeGenerated(
    folder,
    [[path.join(folder, module), generated]],
    check,
    'node scripts/generate-takeover-contract.mjs',
  );
  const index = path.join(APP, 'src/contract/takeover.ts');
  const names = TAKEOVER_FAMILIES.map(([, , schema]) => schema);
  const text = await format(
    `// Generated by scripts/generate-takeover-contract.mjs. Per-family hashes of ${TAKEOVER_FIXTURE_NAME}.\nexport { ${names.join(', ')} } from './generated/takeover/${module}';\nexport type { ${TAKEOVER_FAMILIES.map(([, type]) => type).join(', ')} } from './generated/takeover/${module}';`,
    { ...(await resolveConfig(path.join(APP, '.prettierrc.json'))), filepath: index },
  );
  if (check) {
    if (readFileSync(index, 'utf8') !== text) throw new Error('Takeover contract index drift');
  } else writeFileSync(index, text);
  console.log(
    `${check ? 'Checked' : 'Generated'} takeover contract ${identity.sha256}\nFamilies: ${JSON.stringify(identity.families)}`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await generateTakeover(process.argv.includes('--check'));
