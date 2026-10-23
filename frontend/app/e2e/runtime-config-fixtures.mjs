// @ts-check
import {
  DASHBOARD_PAGES_FIXTURE_PATH,
  loadJsonWithIdentity,
} from '../scripts/contract-fixture.mjs';
import { record } from '../scripts/generate-contract.mjs';

const cases = record(record(loadJsonWithIdentity(DASHBOARD_PAGES_FIXTURE_PATH).fixture)['cases']);
/** Modified recorded snapshots: keep recorded instance overrides alongside the new
 * defaults recordings, whose synthetic world has only inherited effective values.
 * @param {string} reference
 */
export function runtimeConfigRead(reference) {
  const prefix = 'runtime_config_overrides:';
  if (!reference.startsWith(prefix)) return null;
  const [family, name] = reference.slice(prefix.length).split('.');
  const found = record(record(cases[family ?? ''])[name ?? '']);
  const body = structuredClone(record(found['body']));
  const modules = body['modules'];
  if (!Array.isArray(modules)) throw new Error('Missing settings modules');
  body['modules'] = modules.map((raw) => {
    const module = record(raw);
    const id = module['id'];
    if (id !== 'loop' && id !== 'missions' && id !== 'fleet') return module;
    const saved = record(record(record(cases['settings'])[`saved_${id}`])['body']);
    const overrides = saved['modules'];
    if (!Array.isArray(overrides)) throw new Error('Missing instance modules');
    return structuredClone(overrides.map(record).find((entry) => entry['id'] === id));
  });
  return { status: Number(found['status']), body };
}
/** Exact recorded predecessor, save and readback for each machine fallback. */
export const RUNTIME_CONFIG_SAVES = Object.freeze({
  'run-defaults': { before: 'read_after_saved_instance_defaults', suffix: 'run_defaults' },
  'loop-defaults': { before: 'read_after_saved_tournament_cards', suffix: 'loop_defaults' },
  'missions-defaults': { before: 'read_after_saved_loop_defaults', suffix: 'missions_defaults' },
  'fleet-defaults': { before: 'read_after_saved_missions_defaults', suffix: 'fleet_defaults' },
});
export const RUNTIME_CONFIG_CONTEXT =
  'settings_switch_records.read_config_after_switching_back_every_record_as_it_was';

/** @type {Readonly<Record<string, import('./scenarios.mjs').Scenario>>} */
export const RUNTIME_CONFIG_SCENARIOS = Object.fromEntries(
  Object.entries(RUNTIME_CONFIG_SAVES).flatMap(([module, transition]) =>
    ['saved', 'stale', 'unknown', 'override'].map((mode) => [
      `config_fields_runtime_${transition.suffix}_${mode}`,
      {
        description: `Recorded ${module} ${mode}; settings only, no automation.`,
        harvest: 'off',
        get: {
          config: RUNTIME_CONFIG_CONTEXT,
          settings: `${mode === 'override' ? 'runtime_config_overrides:' : ''}settings_modules.${transition.before}`,
        },
        writes: {
          settingsSave:
            mode === 'unknown'
              ? { mode: 'drop' }
              : {
                  case: `${mode === 'override' ? 'runtime_config_overrides:' : ''}settings_modules.${mode === 'saved' || mode === 'override' ? 'saved' : 'stale_revision'}_${transition.suffix}`,
                  ...(mode === 'saved' || mode === 'override'
                    ? {
                        reads: {
                          settings: `${mode === 'override' ? 'runtime_config_overrides:' : ''}settings_modules.read_after_saved_${transition.suffix}`,
                        },
                      }
                    : {}),
                },
        },
      },
    ]),
  ),
);
