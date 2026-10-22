// @ts-check
/** Fixture choices only; HTTP routing and per-browser state belong to fake-backend.mjs. */
import { loadFixture } from '../scripts/contract-fixture.mjs';
import { RUNTIME_SAVES } from './runtime-fixtures.mjs';

/**
 * GET keys are endpoint ids, pathnames, or full paths (including the query).
 * Values name dashboard `family.case` entries, or `502` for a Flask-like page.
 * Write keys are endpoint ids or `endpoint:action` / `endpoint:true|false`.
 * A write can select a fixture case and switch the session's harvest sample on success.
 * @typedef {'ok' | 'refused' | 'unknown' | 'drop' | 'hold'} WriteMode
 * `reads` switches this session's reads (GET keys as above) once the write was answered or
 * dropped after the server acted: the save the next read shows. A held write switches nothing.
 * @typedef {{ mode?: WriteMode, case?: string, after?: string, reads?: Readonly<Record<string, string>> }} WriteChoice
 * @typedef {{
 *   description: string,
 *   harvest: string,
 *   get?: Readonly<Record<string, string>>,
 *   scan?: 'fresh' | 'fixture',
 *   linkedCollector?: boolean,
 *   processes?: readonly unknown[],
 *   operation?: Readonly<Record<string, unknown>>,
 *   writeMode?: WriteMode,
 *   runtimeSave?: keyof typeof RUNTIME_SAVES,
 *   writes?: Readonly<Record<string, WriteMode | WriteChoice>>
 * }} Scenario
 */

/** @type {Readonly<Record<string, string>>} */
export const DEFAULT_GETS = Object.freeze({
  status: 'status.processes_empty',
  calibrate: 'recognition_reads.calibrate_status_of_the_first_account',
  templates: 'recognition_reads.templates_of_the_first_account',
  required: 'recognition_reads.required_images_some_captured',
  modules: 'recognition_reads.module_catalogue_nothing_learned',
  scanPlan: 'recognition_reads.scan_plan_of_the_first_account',
  scanPlanPreset: 'recognition_reads.scan_plan_for_a_run',
  analysisStatus: 'screen_analysis.status_idle_nothing_was_ever_analysed',
  analysisFrame: 'screen_analysis.frame_of_a_finished_analysis_by_its_operation',
  frame: 'recognition_images.frame_png_remembered_under_the_token',
  templateImage: 'recognition_images.read_a_captured_template',
  artwork: 'recognition_images.artwork_a_text_badge_for_a_control_the_game_draws_as_text',
  battlesActive: 'battles_active.null_no_driver',
  schedule: 'schedule_status.scheduler_not_observed',
  battles: 'battles_history.empty',
  config: 'config.taps_true',
  accounts: 'accounts.none_active',
  runs: 'runs.ready',
  wizardTools: 'wizard_tools.installed',
  wizardState: 'wizard_state.after_scan',
  wizardEmulators: 'wizard_emulators.instances_with_names_and_ports',
  resolution: 'emulator_inventory.resolution_portrait_reference',
  runControls: 'run_controls.ad_gems_on_floating_off',
  readiness: 'readiness.ready_with_context',
  profileFiles: 'profile_reads.profile_files_with_a_draft_and_the_starter',
  profileSource: 'profile_reads.profile_src_valid',
  settings: 'settings.populated_account_every_module',
  runTemplates:
    'collection_first_policy.read_the_run_templates_that_carry_the_default_gathering_policies',
  vocab: 'profile_reads.vocab_ok',
  runtime: 'runtime_state.idle_server_build_matches_the_source_on_disk',
  runtimeEvents: 'runtime_diagnostics.every_event_oldest_first_with_log_coordinates',
});

/** Collection page reads shared by its save and refusal scenarios. */
const collectionGets = Object.freeze({
  config: 'config_state.read_before_the_save',
  accounts: 'accounts.none_active',
  profileSource: 'collection_policies.read_before_the_first_save',
  settings: 'settings.populated_account_every_module',
  vocab: 'profile_reads.vocab_ok',
});

/** Emulators page reads shared by its connection and tools scenarios. */
const emulatorsGets = Object.freeze({
  config: 'config_state.read_before_the_save',
  accounts: 'accounts.none_active',
  settings: 'settings.populated_account_every_module',
  wizardTools: 'emulator_tools.tools_idle_before_any_install',
  // The scan whose configured address (fake:1) is the one the config read names.
  wizardEmulators: 'wizard_emulators.instances_with_names_and_ports',
});

/** Recognition reads and the recorded reads that settle each successful write. */
const recognitionGets = Object.freeze({
  config: 'config_state.read_before_the_save',
  status: 'status.processes_empty',
  battlesActive: 'battles_active.null_no_driver',
  runs: 'runs.ready',
});

const recognitionWrites = Object.freeze({
  calibrateStart: {
    case: 'calibrate_writes.start_bootstrap_with_the_action_capture_flows',
    reads: { calibrate: 'calibrate_writes.read_the_running_calibration_by_operation' },
  },
  calibrateObserve: {
    case: 'calibrate_writes.observe_watch_30_seconds',
    reads: { calibrate: 'calibrate_writes.read_the_running_observation_by_operation' },
  },
  calibrateStop: {
    case: 'calibrate_writes.stop_running_calibration_asks_the_worker_to_stop',
    reads: { calibrate: 'calibrate_writes.read_the_calibration_that_was_asked_to_stop' },
  },
  calibrateApply: {
    case: 'calibrate_writes.apply_awaiting_apply_is_applied',
    reads: { calibrate: 'calibrate_writes.read_the_applied_calibration_by_operation' },
  },
  analysisStart: {
    case: 'screen_analysis.start_accepted',
    reads: {
      analysisStatus: 'screen_analysis.status_done_with_matches_and_an_ambiguous_one',
      analysisFrame: 'screen_analysis.frame_of_a_finished_analysis_by_its_operation',
    },
  },
  templateWrite: {
    case: 'recognition_images.save_a_crop_of_the_cached_frame',
    reads: {
      templates: 'recognition_images.read_the_template_list_after_the_save',
      scanPlan:
        'recognition_images.read_the_scan_plan_after_the_save_shows_the_cut_screen_and_its_verification',
      templateImage: 'recognition_images.read_the_saved_template',
    },
  },
});

/** Every harvest sample is directly selectable by its fixture name. @type {Record<string, Scenario>} */
const samples = Object.fromEntries(
  Object.keys(loadFixture().status).map((harvest) => [
    harvest,
    { description: `Harvest status.${harvest}, fresh scan and default Dashboard reads.`, harvest },
  ]),
);

/**
 * Environment E0 of spec 9.1 for every sample, as `e0_<sample>`: the sample
 * on a fresh scan with no processes, and a config read with `allow_taps` false.
 * @type {Record<string, Scenario>}
 */
const e0Samples = Object.fromEntries(
  Object.keys(loadFixture().status).map((harvest) => [
    `e0_${harvest}`,
    {
      description: `Spec 9.1 E0: harvest status.${harvest}, fresh scan, allow_taps false.`,
      harvest,
      get: { config: 'config.taps_false' },
    },
  ]),
);

/** @type {Readonly<Record<string, Scenario>>} */
export const SCENARIOS = Object.freeze({
  ...samples,
  ...e0Samples,
  recognition: {
    description: 'Recognition idle with recorded capture, observation, analysis and crop writes.',
    harvest: 'off',
    get: recognitionGets,
    writes: recognitionWrites,
  },
  recognition_running: {
    description: 'Recognition calibration running; Stop requests cooperative cancellation.',
    harvest: 'off',
    get: {
      ...recognitionGets,
      calibrate: 'calibrate_writes.read_the_running_calibration_by_operation',
    },
    writes: { calibrateStop: recognitionWrites.calibrateStop },
  },
  recognition_awaiting_apply: {
    description: 'Recognition sealed evidence awaits Apply.',
    harvest: 'off',
    get: {
      ...recognitionGets,
      calibrate: 'recognition_reads.calibrate_status_awaiting_apply_with_the_sealed_evidence',
    },
    writes: { calibrateApply: recognitionWrites.calibrateApply },
  },
  recognition_apply_refused: {
    description: 'Recognition Apply refuses a stale operation revision.',
    harvest: 'off',
    get: {
      ...recognitionGets,
      calibrate: 'recognition_reads.calibrate_status_awaiting_apply_with_the_sealed_evidence',
    },
    writes: { calibrateApply: { case: 'calibrate_writes.apply_stale_revision_409' } },
  },
  recognition_apply_lost: {
    description: 'Recognition Apply acts but its answer is lost; read the applied operation.',
    harvest: 'off',
    get: {
      ...recognitionGets,
      calibrate: 'recognition_reads.calibrate_status_awaiting_apply_with_the_sealed_evidence',
    },
    writes: { calibrateApply: { ...recognitionWrites.calibrateApply, mode: 'drop' } },
  },
  recognition_setup_finished: {
    description: 'Recognition setup battle finished and Home was verified with target evidence.',
    harvest: 'off',
    get: {
      ...recognitionGets,
      calibrate:
        'recognition_reads.calibrate_status_setup_battle_finished_and_home_verified_with_target_evidence',
    },
  },
  recognition_failed: {
    description: 'Recognition failed capture retains its error and sealed evidence.',
    harvest: 'off',
    get: {
      ...recognitionGets,
      calibrate:
        'recognition_reads.calibrate_status_failed_keeps_the_error_and_the_evidence_that_was_sealed',
    },
  },
  recognition_aborted: {
    description: 'Recognition capture was aborted by a person; partial evidence remains.',
    harvest: 'off',
    get: {
      ...recognitionGets,
      calibrate:
        'recognition_reads.calibrate_status_aborted_by_a_person_keeps_the_partial_evidence',
    },
  },
  recognition_restore_pending: {
    description: 'Recognition original modules still need restoration.',
    harvest: 'off',
    get: {
      ...recognitionGets,
      calibrate:
        'recognition_reads.calibrate_status_restoration_required_with_the_restore_file_present',
    },
  },
  recognition_artifact_error: {
    description: 'Recognition sealed report changed and is unavailable.',
    harvest: 'off',
    get: {
      ...recognitionGets,
      calibrate:
        'recognition_reads.calibrate_status_report_changed_after_it_was_sealed_is_unavailable',
    },
  },
  recognition_taps_off: {
    description: 'Recognition tapping is disabled; starting calibration is refused.',
    harvest: 'off',
    get: {
      ...recognitionGets,
      config: 'config.taps_false',
      calibrate: 'recognition_reads.calibrate_status_taps_not_allowed',
    },
    writes: { calibrateStart: { case: 'calibrate_writes.start_taps_off_409' } },
  },
  recognition_owned: {
    description: 'Recognition a listed runner owns the device; Start and Observe are refused.',
    harvest: 'off',
    get: { ...recognitionGets, status: 'status.processes_two_rows_same_runner' },
    writes: {
      calibrateStart: { case: 'calibrate_writes.start_while_a_run_owns_the_device_409' },
      calibrateObserve: { case: 'calibrate_writes.observe_while_a_run_owns_the_device_409' },
    },
  },
  recognition_live_battle: {
    description: 'Recognition a recorded active battle is present.',
    harvest: 'off',
    get: { ...recognitionGets, battlesActive: 'battles_active.runtime_ad_orbit_shopping' },
  },
  recognition_images_missing: {
    description: 'Recognition Start is refused because navigation images are missing.',
    harvest: 'off',
    get: recognitionGets,
    writes: {
      calibrateStart: { case: 'calibrate_writes.start_without_the_navigation_images_409' },
    },
  },
  recognition_start_lost: {
    description: 'Recognition Start is recorded and loses its answer; read the latest operation.',
    harvest: 'off',
    get: recognitionGets,
    writes: {
      calibrateStart: {
        case: recognitionWrites.calibrateStart.case,
        mode: 'drop',
        reads: {
          calibrate:
            'calibrate_writes.read_the_latest_calibration_of_the_context_after_a_lost_answer',
        },
      },
    },
  },
  recognition_observe_refused: {
    description: 'Recognition Observe is refused while a calibration runs.',
    harvest: 'off',
    get: {
      ...recognitionGets,
      calibrate: 'calibrate_writes.read_the_running_calibration_by_operation',
    },
    writes: {
      calibrateObserve: { case: 'calibrate_writes.observe_while_a_calibration_is_running_409' },
    },
  },
  recognition_untracked: {
    description: 'Recognition shared observations have no tracked operation and can be applied.',
    harvest: 'off',
    get: {
      ...recognitionGets,
      calibrate: 'recognition_reads.calibrate_status_shared_files_of_an_untracked_calibration',
    },
    writes: {
      calibrateApply: { case: 'calibrate_writes.apply_saved_observations_of_no_operation' },
    },
  },
  recognition_analysis: {
    description: 'Recognition analysis completed with matches and an ambiguous match.',
    harvest: 'off',
    get: {
      ...recognitionGets,
      analysisStatus: 'screen_analysis.status_done_with_matches_and_an_ambiguous_one',
    },
    writes: { analysisStart: recognitionWrites.analysisStart },
  },
  recognition_analysis_launch_failed: {
    description:
      'Recognition analysis launch receipt followed by the recorded status of the same failed operation.',
    harvest: 'off',
    get: recognitionGets,
    writes: {
      analysisStart: {
        case: 'screen_analysis.start_retry_of_a_failed_start_answers_the_failed_operation',
        reads: { analysisStatus: 'screen_analysis.read_the_operation_of_the_failed_start' },
      },
    },
  },
  recognition_analysis_no_matches: {
    description:
      'An existing analysis succeeded without matches; no launch in this browser session.',
    harvest: 'off',
    get: { ...recognitionGets, analysisStatus: 'screen_analysis.status_done_without_any_match' },
  },
  recognition_analysis_ambiguous_screen: {
    description:
      'An existing analysis could not tell two screens apart; no launch in this browser session.',
    harvest: 'off',
    get: {
      ...recognitionGets,
      analysisStatus: 'screen_analysis.status_done_on_a_screen_that_could_not_be_told_apart',
    },
  },
  recognition_analysis_failed: {
    description: 'Recognition analysis failed; a failed worker launch is settled by a read.',
    harvest: 'off',
    get: {
      ...recognitionGets,
      analysisStatus: 'screen_analysis.status_failed_operation_is_an_error_with_its_message',
      analysisFrame: 'screen_analysis.frame_of_an_analysis_with_no_saved_screenshot_409',
    },
    writes: {
      analysisStart: {
        case: 'screen_analysis.start_when_the_worker_cannot_be_started_is_a_text_500',
        reads: { analysisStatus: 'screen_analysis.read_the_operation_of_the_failed_start' },
      },
    },
  },
  recognition_crop_refused: {
    description: 'Recognition crop uses an expired cached frame and is refused.',
    harvest: 'off',
    get: recognitionGets,
    writes: {
      templateWrite: { case: 'recognition_images.save_from_a_frame_that_left_the_cache_409' },
    },
  },
  recognition_crop_exists: {
    description: 'Recognition crop refuses to replace an existing image without consent.',
    harvest: 'off',
    get: recognitionGets,
    writes: {
      templateWrite: {
        case: 'recognition_images.save_over_an_existing_template_without_the_overwrite_flag_409',
      },
    },
  },
  recognition_frame_failed: {
    description: 'Recognition live frame capture answers the recorded 502 page.',
    harvest: 'off',
    get: { ...recognitionGets, frame: 'recognition_images.frame_png_capture_failed_502' },
  },
  runtime: {
    description: 'Runtime settings, source snapshot and recorded diagnostic events.',
    harvest: 'off',
    get: { config: 'config_state.read_before_the_save' },
  },
  runtime_save_loop: {
    description: 'Runtime instance observation settings save and recorded readback.',
    harvest: 'off',
    get: { config: 'config_state.read_before_the_save', settings: RUNTIME_SAVES.loop.before },
    runtimeSave: 'loop',
  },
  runtime_save_tap: {
    description: 'Runtime machine tap settings save and recorded readback.',
    harvest: 'off',
    get: { config: 'config_state.read_before_the_save', settings: RUNTIME_SAVES.tap.before },
    runtimeSave: 'tap',
  },
  runtime_source_changed: {
    description: 'Runtime source changed after load.',
    harvest: 'off',
    get: {
      config: 'config_state.read_before_the_save',
      runtime: 'runtime_state.server_started_before_the_source_changed_restart_needed',
    },
  },
  runtime_worker_unknown: {
    description: 'Worker identity cannot be verified.',
    harvest: 'off',
    get: {
      config: 'config_state.read_before_the_save',
      runtime: 'runtime_state.worker_that_cannot_be_verified_is_unknown_not_dead',
    },
  },
  runtime_truncated: {
    description: 'Malformed and truncated bounded diagnostic scan.',
    harvest: 'off',
    get: {
      config: 'config_state.read_before_the_save',
      runtimeEvents:
        'runtime_diagnostics.malformed_lines_are_counted_and_a_half_written_last_line_is_truncation',
    },
  },
  runtime_read_errors: {
    description: 'Some diagnostic files could not be read.',
    harvest: 'off',
    get: {
      config: 'config_state.read_before_the_save',
      runtimeEvents:
        'runtime_diagnostics.one_file_cannot_be_read_the_others_are_returned_and_the_error_is_listed',
    },
  },
  runtime_writer_failure: {
    description: 'Dashboard writer reports failed writes.',
    harvest: 'off',
    get: {
      config: 'config_state.read_before_the_save',
      runtimeEvents: 'runtime_diagnostics.writer_health_reports_failed_writes',
    },
  },
  emulators: {
    description: 'Emulators page: adopt a suggested VM and install connection tools.',
    harvest: 'off',
    get: emulatorsGets,
    writes: {
      adopt: {
        case: 'emulator_actions.adopt_a_serial_saved_and_connected',
        reads: {
          config: 'emulator_actions.config_after_the_adopt_names_the_serial',
          wizardState: 'emulator_actions.wizard_state_after_the_adopt_holds_the_receipt',
        },
      },
      launch: { case: 'emulator_actions.launch_a_vm_no_instance_uses_skips_the_boot_pipeline' },
      toolsInstall: {
        case: 'emulator_tools.install_accepted_202_the_download_starts',
        reads: { wizardTools: 'emulator_tools.tools_installed_after_the_install' },
      },
    },
  },
  emulators_not_connected: {
    description: 'Emulators page: adoption saves the serial but does not connect it.',
    harvest: 'off',
    get: emulatorsGets,
    writes: {
      adopt: {
        case: 'emulator_actions.adopt_saved_but_not_connected',
        reads: { config: 'emulator_actions.config_after_the_adopt_names_the_serial' },
      },
    },
  },
  emulators_two_running: {
    description: 'Emulators page: two VMs are running; a stale adoption is refused.',
    harvest: 'off',
    get: {
      ...emulatorsGets,
      wizardEmulators:
        'emulator_inventory.two_running_vms_the_configured_one_is_down_no_automatic_choice',
    },
    writes: { adopt: { case: 'emulator_actions.adopt_the_instance_changed_since_the_scan' } },
  },
  emulators_placeholder: {
    description: 'Emulators page: no emulator serial has been configured.',
    harvest: 'off',
    get: {
      ...emulatorsGets,
      wizardEmulators: 'emulator_inventory.no_serial_configured_yet_placeholder',
    },
    writes: {
      adopt: {
        case: 'emulator_actions.adopt_a_serial_saved_and_connected',
        reads: { config: 'emulator_actions.config_after_the_adopt_names_the_serial' },
      },
    },
  },
  emulators_owned: {
    description: 'Emulators page: a runner owns the device and connection writes are refused.',
    harvest: 'off',
    get: emulatorsGets,
    writes: {
      adopt: { case: 'emulator_actions.adopt_refused_while_a_runner_owns_the_device' },
      launch: { case: 'emulator_actions.launch_refused_while_a_runner_owns_the_device' },
      reconnect: { case: 'reconnect.refused_while_a_runner_is_listed' },
    },
  },
  emulators_bluestacks: {
    description:
      'Recorded BlueStacks inventory: Prepare waits while any HD-Player runs; ADB is global.',
    harvest: 'off',
    get: {
      ...emulatorsGets,
      wizardEmulators:
        'emulator_bluestacks_inventory.one_stopped_one_running_instance_adb_off_and_a_display_that_is_not_ok',
    },
    writes: {
      prepare: {
        case: 'emulator_bluestacks_inventory.prepare_the_stopped_instance_is_refused_too_while_another_instance_runs',
      },
    },
  },
  emulators_bluestacks_runner_listed: {
    description: 'Same recorded BlueStacks inventory after a status read lists a runner.',
    harvest: 'off',
    get: {
      ...emulatorsGets,
      wizardEmulators:
        'emulator_bluestacks_inventory.one_stopped_one_running_instance_adb_off_and_a_display_that_is_not_ok',
      status: 'status.processes_two_rows_same_runner',
    },
  },
  emulators_bluestacks_prepare_modified: {
    description:
      'Browser supplies labelled all-stopped modification; Prepare answer and readback are verbatim r11.',
    harvest: 'off',
    get: {
      ...emulatorsGets,
      wizardEmulators:
        'emulator_bluestacks_inventory.one_stopped_one_running_instance_adb_off_and_a_display_that_is_not_ok',
    },
    writes: {
      prepare: {
        case: 'emulator_bluestacks_inventory.prepare_the_stopped_instance_once_nothing_runs',
        reads: {
          wizardEmulators:
            'emulator_bluestacks_inventory.read_after_the_prepare_display_ok_and_adb_on',
        },
      },
    },
  },
  emulators_launch_failed: {
    description: 'Emulators page: the manager reports a failed launch in an HTTP 200 answer.',
    harvest: 'off',
    get: emulatorsGets,
    writes: { launch: { case: 'emulator_actions.launch_the_manager_reported_a_failure' } },
  },
  emulators_launch_lost: {
    description: 'Emulators page: a launch is recorded but its answer is lost.',
    harvest: 'off',
    get: emulatorsGets,
    writes: { launch: { mode: 'drop' } },
  },
  emulators_scan_error: {
    description: 'Emulators page: discovery answers its recorded scan error.',
    harvest: 'off',
    get: { ...emulatorsGets, wizardEmulators: 'wizard_emulators.scan_error' },
  },
  emulators_none: {
    description: 'Emulators page: discovery finds no emulators.',
    harvest: 'off',
    get: { ...emulatorsGets, wizardEmulators: 'wizard_emulators.none' },
  },
  emulators_tools_downloading: {
    description: 'Emulators page: connection tools are downloading with recorded progress.',
    harvest: 'off',
    get: { ...emulatorsGets, wizardTools: 'emulator_tools.tools_downloading_with_progress' },
  },
  emulators_tools_error: {
    description: 'Emulators page: the connection tools installation failed.',
    harvest: 'off',
    get: {
      ...emulatorsGets,
      wizardTools: 'emulator_tools.tools_error_state_after_a_failed_install',
    },
  },
  emulators_resolution_landscape: {
    description: 'Emulators page: the resolution check reports a landscape display.',
    harvest: 'off',
    get: {
      ...emulatorsGets,
      resolution: 'emulator_inventory.resolution_landscape_is_not_portrait',
    },
  },
  emulators_runner_listed: {
    description: 'Emulators page: the status read lists a runner, so connection changes wait.',
    harvest: 'off',
    get: { ...emulatorsGets, status: 'status.processes_two_rows_same_runner' },
  },
  emulators_reconnect_offline: {
    description: 'Emulators page: reconnect answers with the device still offline.',
    harvest: 'off',
    get: emulatorsGets,
    writes: { reconnect: { case: 'reconnect.answered_offline_after_the_retries' } },
  },
  collection: {
    description: 'Collection page: saved rewards and chores are shown on the next read.',
    harvest: 'off',
    get: collectionGets,
    writes: {
      settingsSave: {
        case: 'settings.saved_rewards',
        reads: { settings: 'settings.read_after_every_module_was_saved' },
      },
      profilePatch: {
        case: 'collection_policies.chores_reordered_and_one_switched_off',
        reads: { profileSource: 'collection_policies.read_after_the_saves_holds_every_change' },
      },
    },
  },
  collection_first_policy: {
    description: 'Collection C5: an empty policy library creates its first policy from a template.',
    harvest: 'off',
    get: {
      ...collectionGets,
      profileSource: 'collection_first_policy.read_a_profile_with_no_gathering_policies',
      settings: 'settings.profile_without_gathering_policies_has_no_gather_modules',
    },
    writes: {
      profilePatch: {
        case: 'collection_first_policy.first_policy_created_from_the_farm_template_default',
        reads: {
          profileSource: 'collection_first_policy.read_after_the_first_policy_holds_it_unbound',
        },
      },
    },
  },
  collection_starter: {
    description: 'Collection page: the starter profile has read-only profile settings.',
    harvest: 'off',
    get: {
      ...collectionGets,
      settings: 'settings.starter_profile_active_profile_modules_read_only',
    },
    writes: {
      settingsSave: { case: 'settings.starter_profile_active_a_profile_module_is_refused' },
    },
  },
  collection_save_lost: {
    description: 'Collection page: the settings save commits but its answer is lost.',
    harvest: 'off',
    get: collectionGets,
    writes: {
      settingsSave: {
        mode: 'drop',
        reads: { settings: 'settings.read_after_the_unanswered_save_holds_the_value' },
      },
    },
  },
  collection_stale: {
    description: 'Collection page: a stale settings save is refused; reads show the other save.',
    harvest: 'off',
    get: collectionGets,
    writes: {
      settingsSave: {
        case: 'settings.stale_revision_another_client_saved_first',
        reads: {
          settings: 'settings.read_after_the_stale_refusal_holds_the_other_clients_save',
        },
      },
    },
  },
  collection_policy_added: {
    description: 'Collection page: an unused gathering policy is saved in the profile.',
    harvest: 'off',
    get: collectionGets,
    writes: {
      profilePatch: {
        case: 'collection_policies.policy_added_that_no_run_uses',
        reads: { profileSource: 'collection_policies.read_after_the_saves_holds_every_change' },
      },
    },
  },
  collection_delete_in_use: {
    description: 'Collection page: deleting a policy used by a run is refused with problems.',
    harvest: 'off',
    get: collectionGets,
    writes: {
      profilePatch: { case: 'collection_policies.policy_deleted_while_a_run_uses_it' },
    },
  },
  sketch: {
    description:
      'Manual gem collector, fresh scan/publication, unresolved setup battle; Stop held.',
    harvest: 'manual_collector',
    linkedCollector: true,
    get: { status: 'status.guards_setup_and_collection_blocking_the_same_operation' },
    writes: { cancel: 'hold', 'control:kill': 'hold' },
  },
  idle: {
    description: 'Harvesting Off, no listed processes, fresh scan.',
    harvest: 'off',
  },
  cold_502: {
    description: 'Status returns a Flask-like 502 page from the first read onward.',
    harvest: 'off',
    get: { status: '502' },
  },
  no_tracked_battle: {
    description: 'Manual collector with no tracked battle in the active-battle answer.',
    harvest: 'manual_collector',
    linkedCollector: true,
  },
  active_battle_routines: {
    description: 'Active battle with ad gems, floating gems and shopping runtime reports.',
    harvest: 'owned_by_run_gathers',
    get: {
      battlesActive: 'battles_active.runtime_ad_orbit_shopping',
      battles: 'battles_history.ended_with_final_wave',
    },
  },
  runs_live_overrides: {
    description:
      'Runs page: an active battle with a controls change partly applied (marks Changed and Waiting).',
    harvest: 'owned_by_run_gathers',
    get: {
      battlesActive: 'battles_active.commands_controls_pending_some_paths_applied_action_completed',
    },
  },
  runs_live_applied: {
    description: 'Runs page: an active battle whose overrides are all applied (live Save open).',
    harvest: 'owned_by_run_gathers',
    get: { battlesActive: 'battles_active.commands_controls_applied_with_overrides_action_failed' },
  },
  runs_saved: {
    description:
      'Runs page: a saved run read before its first save; a save answers 200 and the read then holds it.',
    harvest: 'off',
    get: { runControls: 'run_controls_save.read_before_the_first_save' },
    writes: {
      runControlsSave: {
        case: 'run_controls_save.saved_switch_off',
        reads: { runControls: 'run_controls_save.read_after_the_save_holds_the_new_values' },
      },
    },
  },
  runs_saved_unanswered: {
    description:
      'Runs page: the save is written, then the answer fails (a text 500); the next read holds every sent value.',
    harvest: 'off',
    get: { runControls: 'run_controls_save.read_before_the_unanswered_save' },
    writes: {
      runControlsSave: {
        case: 'run_controls_save.saved_then_the_answer_failed_500',
        reads: {
          runControls: 'run_controls_save.read_after_the_unanswered_save_holds_every_sent_value',
        },
      },
    },
  },
  runs_saved_lost: {
    description:
      'Runs page: the save is written and its answer is lost on the way; the next read shows it.',
    harvest: 'off',
    get: { runControls: 'run_controls_save.read_before_the_lost_answer' },
    writes: {
      runControlsSave: {
        mode: 'drop',
        reads: { runControls: 'run_controls_save.read_after_a_lost_answer_the_save_is_there' },
      },
    },
  },
  profiles: {
    description:
      'Profiles page: two local accounts, none chosen for this emulator; selecting Alpha binds it and the config then names it.',
    harvest: 'off',
    get: {
      config: 'config_state.read_before_the_save',
      accounts: 'accounts.none_active',
      '/api/profile-src/broken': 'profile_reads.profile_src_with_problems',
      '/api/profile-src/default': 'profile_reads.profile_src_of_the_starter',
      '/api/profile-src/theirs':
        'profile_reads.profile_src_of_the_other_accounts_profile_is_not_refused',
    },
    writes: {
      'accountsWrite:select': {
        case: 'accounts_write.select_an_existing_account',
        reads: {
          config: 'config_state.populated_accounts_and_loadouts',
          accounts: 'accounts_write.read_after_select',
        },
      },
      accountTier: {
        case: 'accounts_write.tier_saved_by_the_operator',
        reads: {
          accounts: 'accounts_write.read_after_the_tier',
          profileSource:
            'accounts_write.profile_source_after_the_tier_records_the_operator_as_provenance',
        },
      },
      profileActivate: { case: 'profile_files_write.activate_the_starter' },
      profileCopy: { case: 'profile_files_write.copy_one_of_your_own_profiles' },
      profilePromote: {
        case: 'profile_files_write.promotion_returns_the_problems_it_does_not_enforce_them',
        reads: { profileFiles: 'profile_files_write.files_after_the_promotion_activate_nothing' },
      },
    },
  },
  profiles_create_failed: {
    description:
      'Profiles page: creating an account writes its profile file, then the config save fails (400); the reads show the left-behind file.',
    harvest: 'off',
    get: {
      config: 'config_state.read_before_the_save',
      accounts: 'accounts_write.read_before_any_account',
    },
    writes: {
      'accountsWrite:create': {
        case: 'accounts_write.create_then_the_config_save_failed_leaves_the_profile_file',
        reads: {
          accounts: 'accounts_write.read_after_the_failed_create_no_account',
          profileFiles: 'accounts_write.profile_files_after_the_failed_create_list_the_orphan',
        },
      },
    },
  },
  profiles_setup: {
    description:
      'Profiles page: connection tools missing, original modules waiting to be restored, a run not ready.',
    harvest: 'off',
    get: {
      config: 'config_state.read_before_the_save',
      accounts: 'accounts.none_active',
      wizardTools: 'wizard_tools.not_installed',
      calibrate: 'calibrate_status.restore_pending',
      runs: 'runs.not_ready_image_row',
    },
  },
  profiles_copy_lost: {
    description:
      'Profiles page: a copy is written and its answer is lost on the way; the next profile list shows it.',
    harvest: 'off',
    get: { config: 'config_state.read_before_the_save', accounts: 'accounts.none_active' },
    writes: {
      profileCopy: {
        mode: 'drop',
        reads: {
          profileFiles:
            'profile_files_write.files_after_the_copy_list_it_and_copy_activates_nothing',
        },
      },
    },
  },
  profiles_owned: {
    description:
      'Profiles page: a runner owns the device; selecting an account is refused (409 device_owned).',
    harvest: 'off',
    get: { config: 'config_state.read_before_the_save', accounts: 'accounts.none_active' },
    writes: { 'accountsWrite:select': 'refused' },
  },
  runs_saved_held: {
    description:
      'Runs page: a saved run whose save is recorded and never answered (a reload while it is in flight).',
    harvest: 'off',
    get: { runControls: 'run_controls_save.read_before_the_first_save' },
    writes: { runControlsSave: 'hold' },
  },
  runs_live: {
    description:
      'Runs page: an active battle before its first live change; a change is recorded and the next read lists it.',
    harvest: 'off',
    get: { battlesActive: 'run_controls_live.read_before_the_first_change' },
    writes: {
      liveControls: {
        reads: {
          battlesActive: 'run_controls_live.read_after_the_change_lists_the_command_and_its_key',
        },
      },
    },
  },
  runs_live_unknown: {
    description:
      'Runs page: a live change is recorded but its read-back fails (500 command_outcome_unknown).',
    harvest: 'off',
    get: { battlesActive: 'run_controls_live.read_before_the_first_change' },
    writes: { liveControls: 'unknown' },
  },
  prepared_battle: {
    description: 'Prepared battle with no runtime observation yet.',
    harvest: 'off',
    get: { battlesActive: 'battles_active.prepared' },
  },
  setup_guard_block: {
    description: 'Unresolved setup battle blocks Start and Collect; setup failure is visible.',
    harvest: 'setup_guard_block',
    get: {
      status: 'status.guards_setup_and_collection_blocking_the_same_operation',
      calibrate: 'calibrate_status.failed_setup_unverified_final_screen',
    },
    writes: {
      'control:start': { case: 'control.start_refused_by_setup_guard' },
      'control:start_gems': { case: 'control.start_gems_refused_by_collection_guard' },
    },
  },
  x2a: {
    description:
      '9.1 X2a: status and config fail; at the click GET /api/harvest names the context.',
    harvest: 'off',
    get: { status: '502', config: '502' },
  },
  x2b: {
    description: '9.1 X2b: status and config fail; GET /api/harvest names no context either.',
    harvest: 'status_failed',
    get: { status: '502', config: '502' },
  },
  two_runners: {
    description:
      '9.1 X8: two untracked runners of one script on a fresh scan; Off; allow_taps false.',
    harvest: 'off',
    get: { status: 'status.processes_two_rows_same_runner', config: 'config.taps_false' },
    writes: { 'control:kill': 'hold' },
  },
  x9: {
    description:
      '9.1 X9: a linked process row with a malformed operation id ({pid: 9009, operation_id: 7}); Off; allow_taps false.',
    harvest: 'off',
    get: { config: 'config.taps_false' },
    processes: [{ pid: 9009, operation_id: 7 }],
  },
  x9_taps: {
    description:
      '9.1 X9 with taps allowed: the same malformed linked row ({pid: 9009, operation_id: 7}); Off; allow_taps true.',
    harvest: 'off',
    processes: [{ pid: 9009, operation_id: 7 }],
  },
  stopping_no_revision: {
    description:
      'A stopping holder whose operation carries no valid revision (S-050: Stop waits for fresh status); allow_taps false.',
    harvest: 'stopping',
    get: { config: 'config.taps_false' },
    operation: { revision: null },
  },
  runner_created_null: {
    description: '9.1 X8 row 1: an untracked runner without its start time (S-060).',
    harvest: 'off',
    get: { status: 'status.processes_untracked_created_null', config: 'config.taps_false' },
  },
  x10_owner: {
    description:
      'A Pause refused by the r6 lease holder notice (device_owned_lease, holder 4242 named).',
    harvest: 'collecting',
    get: { config: 'config.taps_false' },
    writes: { 'harvest:false': { mode: 'refused', case: 'refusals.device_owned_lease' } },
  },
  marker_failed: {
    description:
      'Turn input off answers disable_marker_write_failed (server error text shown in full).',
    harvest: 'collecting',
    writes: {
      'automationAccess:false': {
        mode: 'unknown',
        case: 'automation_access.disable_marker_write_failed',
      },
    },
  },
  refusal: {
    description: "Writes return the endpoint's recorded owner or coded refusal.",
    harvest: 'foreign_process',
    writeMode: 'refused',
  },
  unknown_writes: {
    description: 'Writes return recorded 5xx unknown outcomes (diagnostics use a Flask 500 page).',
    harvest: 'collecting',
    writeMode: 'unknown',
  },
  dropped_writes: {
    description: 'Writes are recorded, then their sockets are destroyed without an answer.',
    harvest: 'collecting',
    writeMode: 'drop',
  },
});
