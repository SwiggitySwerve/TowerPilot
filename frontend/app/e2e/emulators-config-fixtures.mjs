// @ts-check
import {
  DASHBOARD_PAGES_FIXTURE_PATH,
  loadJsonWithIdentity,
} from '../scripts/contract-fixture.mjs';

const fixture =
  /** @type {{cases: Record<string, Record<string, {status: number, body: Record<string, unknown>, request: {body?: Record<string, unknown>}}>>}} */ (
    loadJsonWithIdentity(DASHBOARD_PAGES_FIXTURE_PATH).fixture
  );
const cases = fixture.cases;

/** @param {string} name @returns {{status: number, body: Record<string, unknown>, request: {body?: Record<string, unknown>}}} */
export function emulatorConfigCase(name) {
  const [family, key] = name.split('.');
  const found = cases[family ?? '']?.[key ?? ''];
  if (found === undefined) throw new Error(`Missing recorded case ${name}`);
  return structuredClone(found);
}

/** A synthetic world's pre-save GET was not recorded. Restore the recorded POST's
 * revision and the recorded metadata's default values; keep its
 * server metadata and options exactly. This is the only baseline modification. */
export function emulatorConfigBefore() {
  const saved = emulatorConfigCase('settings_modules.saved_instance_defaults');
  const body = saved.body;
  const modules =
    /** @type {{id: string, fields: {path: string, value: unknown, default: unknown}[]}[]} */ (
      body['modules']
    );
  for (const module of modules) {
    if (module.id !== 'instance-defaults') continue;
    for (const field of module.fields) field.value = field.default;
  }
  body['revision'] = saved.request.body?.['revision'];
  return { status: 200, body };
}

/** @param {string | undefined} reference */
export function emulatorConfigRead(reference) {
  if (reference === 'config_fields_emulators_before') return emulatorConfigBefore();
  if (reference === 'config_fields_emulators_unlisted') {
    const answer = emulatorConfigBefore();
    const modules = /** @type {{id: string, fields: {path: string, value: unknown}[]}[]} */ (
      answer.body['modules']
    );
    const field = modules
      .find((module) => module.id === 'instance-defaults')
      ?.fields.find((field) => field.path === 'preset');
    // Modified recorded saved choice: reuse the invalid recording's unsupported value
    // to exercise retained historical values; no such saved-invalid read was recorded.
    const invalid = emulatorConfigCase('settings_modules.invalid_enum_instance_defaults');
    const values = /** @type {Record<string, unknown>} */ (invalid.request.body?.['values']);
    if (field !== undefined) field.value = values['preset'];
    return answer;
  }
  return null;
}

const base = {
  config: 'settings_switch_records.read_config_after_switching_back_every_record_as_it_was',
  settings: 'config_fields_emulators_before',
  wizardEmulators: 'wizard_emulators.instances_with_names_and_ports',
};

/** @type {Readonly<Record<string, import('./scenarios.mjs').Scenario>>} */
export const EMULATOR_CONFIG_SCENARIOS = {
  config_fields_emulators_defaults: {
    description: 'C15-1..3 recorded defaults save and readback',
    harvest: 'off',
    get: base,
    writes: {
      settingsSave: {
        case: 'settings_modules.saved_instance_defaults',
        reads: { settings: 'settings_modules.read_after_saved_instance_defaults' },
      },
    },
  },
  config_fields_emulators_stale: {
    description: 'C15-1 stale defaults retain the draft',
    harvest: 'off',
    get: base,
    writes: {
      settingsSave: { mode: 'refused', case: 'settings_modules.stale_revision_instance_defaults' },
    },
  },
  config_fields_emulators_invalid: {
    description: 'C15-2 historical unsupported preset stays visible with its reason',
    harvest: 'off',
    get: { ...base, settings: 'config_fields_emulators_unlisted' },
  },
  config_fields_emulators_refused: {
    description: 'C15-1 recorded validation refusal keeps input',
    harvest: 'off',
    get: base,
    // The recording sent a typed-invalid label; the browser cannot produce that type.
    // Reuse its genuine refusal to verify retention after a server-side rejection.
    writes: {
      settingsSave: { mode: 'refused', case: 'settings_modules.invalid_string_instance_defaults' },
    },
  },
  config_fields_emulators_switch: {
    description: 'C15-4 confirmed switch, recorded config verifies new context',
    harvest: 'off',
    get: base,
    writes: {
      settingsSave: {
        case: 'settings_modules.saved_active_instance',
        reads: {
          settings: 'settings_modules.read_after_saved_active_instance',
          config: 'settings_modules.read_config_after_saved_active_instance',
        },
      },
    },
  },
  config_fields_emulators_switch_lost: {
    description: 'C15-4 lost receipt, config still proves the switch',
    harvest: 'off',
    get: base,
    writes: {
      settingsSave: {
        mode: 'drop',
        case: 'settings_modules.saved_active_instance',
        reads: {
          settings: 'settings_modules.read_after_saved_active_instance',
          config: 'settings_modules.read_config_after_saved_active_instance',
        },
      },
    },
  },
  config_fields_emulators_switch_unchanged: {
    description: 'C15-4 lost answer and unchanged config keep Unknown',
    harvest: 'off',
    get: base,
    writes: { settingsSave: { mode: 'drop', case: 'settings_modules.saved_active_instance' } },
  },
  config_fields_emulators_receipt_unverified: {
    description: 'C15-4 successful settings receipt cannot adopt context without config',
    harvest: 'off',
    get: base,
    writes: {
      settingsSave: {
        case: 'settings_modules.saved_active_instance',
        reads: { settings: 'settings_modules.read_after_saved_active_instance' },
      },
    },
  },
};
