// @ts-check
import {
  DASHBOARD_PAGES_FIXTURE_PATH,
  loadJsonWithIdentity,
} from '../scripts/contract-fixture.mjs';

const fixture =
  /** @type {{cases: Record<string, Record<string, {status: number, body: Record<string, unknown>, request: {body?: Record<string, unknown>}}>>}} */ (
    loadJsonWithIdentity(DASHBOARD_PAGES_FIXTURE_PATH).fixture
  );
/** @param {string} reference */
function recorded(reference) {
  const [family = '', key = ''] = reference.split('.');
  const value = fixture.cases[family]?.[key];
  if (value === undefined) throw new Error(`Missing recorded case ${reference}`);
  return structuredClone(value);
}

/** @param {string | undefined} reference */
export function equipmentConfigRead(reference) {
  if (reference === 'config_fields_equipment_empty_lists') {
    // Modified recorded save/readback: replace only the tournament list values with [],
    // since no separate empty-list POST recording exists. Keep its schema/metadata.
    const empty = recorded('settings_modules.saved_tournament_cards');
    const modules = /** @type {{id: string, fields: {value: unknown}[]}[]} */ (
      empty.body['modules']
    );
    const module = modules.find((module) => module.id === 'tournament-cards');
    for (const field of module?.fields ?? []) field.value = [];
    return empty;
  }
  if (reference !== 'config_fields_equipment_modules_before') return null;
  // Modified recorded predecessor: the modules save's ordinary `modules` body exists
  // before its restore edit, but that intermediate config GET was not recorded.
  // Retain the exact preceding config revision and every other key.
  const before = recorded('loadout_restore.read_after_saved_cards_restore');
  const saved = recorded('loadout_restore.saved_modules_restore');
  const loadouts = /** @type {Record<string, unknown>} */ (before.body['loadouts']);
  const body = /** @type {Record<string, unknown>} */ (saved.request.body?.['body']);
  const plain = { ...body };
  delete plain['modules_restore'];
  loadouts['plain'] = plain;
  return before;
}

const tournament = {
  config: 'settings_switch_records.read_config_after_switching_back_every_record_as_it_was',
  settings: 'settings_modules.read_after_saved_run_defaults',
  profileSource: 'ability_policies.read_before_the_first_save',
};
const equipment = {
  config: 'loadout_patch.read_before_the_first_save',
  settings: 'settings.populated_account_every_module',
  profileSource: 'ability_policies.read_before_the_first_save',
};
/** @type {Readonly<Record<string, import('./scenarios.mjs').Scenario>>} */
export const EQUIPMENT_CONFIG_SCENARIOS = {
  config_fields_equipment_empty: {
    description: 'C15-6/7 explicitly modified recorded empty-list save/readback',
    harvest: 'off',
    get: { ...tournament, settings: 'settings_modules.read_after_saved_tournament_cards' },
    writes: {
      settingsSave: {
        case: 'config_fields_equipment_empty_lists',
        reads: { settings: 'config_fields_equipment_empty_lists' },
      },
    },
  },
  config_fields_equipment_lists: {
    description: 'C15-6/7 ordered tournament lists, recorded save and readback',
    harvest: 'off',
    get: tournament,
    writes: {
      settingsSave: {
        case: 'settings_modules.saved_tournament_cards',
        reads: { settings: 'settings_modules.read_after_saved_tournament_cards' },
      },
    },
  },
  config_fields_equipment_invalid: {
    description: 'C15-6/7 genuine server invalid-list refusal retains the draft',
    harvest: 'off',
    get: tournament,
    // The UI refuses non-string members locally. Inject the actual recording's refusal
    // after a valid-string submission to prove server error display and draft retention.
    writes: {
      settingsSave: {
        mode: 'refused',
        case: 'settings_modules.invalid_string_list_tournament_cards',
      },
    },
  },
  config_fields_equipment_stale: {
    description: 'C15-6/7 genuine stale refusal retains draft',
    harvest: 'off',
    get: tournament,
    writes: {
      settingsSave: { mode: 'refused', case: 'settings_modules.stale_revision_tournament_cards' },
    },
  },
  config_fields_equipment_cards: {
    description: 'C15-8 cards restore save and config readback',
    harvest: 'off',
    get: equipment,
    writes: {
      loadoutPatch: {
        case: 'loadout_restore.saved_cards_restore',
        reads: { config: 'loadout_restore.read_after_saved_cards_restore' },
      },
    },
  },
  config_fields_equipment_modules: {
    description: 'C15-9 manual modules remain untouched while restore rows save',
    harvest: 'off',
    get: { ...equipment, config: 'config_fields_equipment_modules_before' },
    writes: {
      loadoutPatch: {
        case: 'loadout_restore.saved_modules_restore',
        reads: { config: 'loadout_restore.read_after_saved_modules_restore' },
      },
    },
  },
  config_fields_equipment_refused: {
    description: 'C15-9 unknown restore module refused verbatim',
    harvest: 'off',
    get: { ...equipment, config: 'loadout_restore.read_after_saved_modules_restore' },
    writes: { loadoutPatch: { mode: 'refused', case: 'loadout_restore.refused_modules_restore' } },
  },
  config_fields_equipment_unused: {
    description: 'C15-8/9 unused loadout restore disabled; ordinary save allowed',
    harvest: 'off',
    get: equipment,
  },
  config_fields_equipment_clear_unused: {
    description: 'C15-8 clearing stored restore of unused loadout stays disabled',
    harvest: 'off',
    get: {
      ...equipment,
      config:
        'loadout_restore_eligibility.read_after_the_clearing_refusal_the_stored_value_remains',
    },
  },
  config_fields_equipment_no_profile: {
    description: 'C15-8 no active profile keeps restore save disabled',
    harvest: 'off',
    get: {
      ...equipment,
      config: 'loadout_restore_eligibility.read_after_the_no_profile_refusal_nothing_changed',
      settings: 'settings.no_active_profile_only_machine_and_emulator_modules',
    },
  },
};
