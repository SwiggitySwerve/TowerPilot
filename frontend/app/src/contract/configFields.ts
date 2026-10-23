/**
 * F6-15 configuration fields on their owning pages (brief
 * backend/logs/reviews/ui-pages/f6-15-config-fields-brief.md): the schemas of the recorded
 * families settings_modules (the typed modules instance-defaults, active-instance, run-defaults,
 * tournament-cards, loop-defaults, missions-defaults, fleet-defaults), settings_switch_records
 * (the active-instance switch keeps every account record), loadout_restore and
 * loadout_restore_eligibility (restore values of a named loadout) in the pages fixture
 * (backend/tests/fixtures/dashboard_contract_pages_v1.json).
 */
export {
  configFieldsConfigAnswerSchema,
  configFieldsSettingsReadAnswerSchema,
  configFieldsSettingsSaveAnswerSchema,
  restoreConfigAnswerSchema,
  restoreEligibilityConfigAnswerSchema,
  restoreEligibilityPatchAnswerSchema,
  restorePatchAnswerSchema,
  switchConfigAnswerSchema,
  switchSettingsReadAnswerSchema,
  switchSettingsSaveAnswerSchema,
} from './generated/dashboard_contract_pages_v1_config_fields.9cfb7fc4.ts';
