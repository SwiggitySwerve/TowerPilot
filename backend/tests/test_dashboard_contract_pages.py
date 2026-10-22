"""The page contract: what the routes behind the remaining pages of the new app answer.

backend/tests/fixtures/dashboard_contract_pages_v1.json is generated here exactly like dashboard_contract_v1.json (the
Dashboard contract, test_dashboard_contract.py): the REAL Flask routes of frontend/dashboard.py driven over
synthetic state in the isolated world of dashboard_contract_world.py - a temporary root, ledger and lease directory, one
fixed clock, an in-memory process table, adb socket and process creation. It never reads or touches the live
backend, device, lease, process table or a running dashboard (127.0.0.1:8630 included). It is a separate file so
the Dashboard contract keeps its hash for the consumers bound to it. The families of this document are generated
in a fixed order and ids are aliased in order of appearance, so a family keeps its content (family_hashes() in
this module gives each family's own hash) when a family is appended after it.

A normal run only compares: any change in a field, a code or a status fails until a developer regenerates it on
purpose and the UI side re-reads it:

    TP_REGENERATE_DASHBOARD_CONTRACT_PAGES=1 python -m pytest backend/tests/test_dashboard_contract_pages.py

TP_DASHBOARD_CONTRACT_PAGES_OUT=<path> writes the generated contract to that path instead of comparing (how a
second tree is generated; the committed fixture is untouched).

Cases are keyed `<family>.<case>` and have the shape of the Dashboard contract: {request: {method, path, body?}, status,
body}; a body that is not JSON is {text}; ids are aliased in order of appearance; the scenario root is `<root>`.

COVERAGE maps every row the page briefs ask for (backend/logs/reviews/ui-pages/README.md "Missing contract cases
for the backend generator" and runs-brief.md section 2) to the cases that satisfy it; a row the backend cannot
produce is in NOT_PRODUCIBLE with the source that shows why. test_every_row_is_covered_or_explained fails when a row
names a case that is not in the fixture and when the fixture holds a case no row names.
"""
import hashlib
import json
import os
from pathlib import Path

import pytest

import test_dashboard_contract as dashboard
from dashboard_contract_cases_accounts import run_accounts_cases, run_profile_files_cases
from dashboard_contract_cases_editors import run_abilities_cases, run_collection_cases, run_equipment_cases
from dashboard_contract_cases_emulators import run_emulator_cases
from dashboard_contract_cases_calibrate import run_calibrate_cases
from dashboard_contract_cases_context import context_fence_cases
from dashboard_contract_cases_history import run_history_cases
from dashboard_contract_cases_recognition import run_recognition_cases
from dashboard_contract_cases_screens import run_later_cases, run_screens_cases
from dashboard_contract_cases_runtime import run_runtime_cases
from dashboard_contract_cases_profile import run_profile_cases, run_schedule_cases
from dashboard_contract_cases_settings import run_settings_cases
from dashboard_contract_cases_runs import run_controls_live_cases, run_controls_save_cases
from dashboard_contract_pages_world import PagesGenerator

FIXTURE = Path(__file__).parent / 'fixtures' / 'dashboard_contract_pages_v1.json'
REGENERATE = 'TP_REGENERATE_DASHBOARD_CONTRACT_PAGES'
OUTPUT = 'TP_DASHBOARD_CONTRACT_PAGES_OUT'

# Order matters: ids are aliased in order of appearance, so a family keeps its ids (and its hash) when
# families are appended after it. Never insert a family before an existing one.
FAMILIES = [run_controls_save_cases, run_controls_live_cases, run_history_cases, run_profile_cases, run_schedule_cases,
            run_settings_cases, run_equipment_cases, run_collection_cases, run_abilities_cases,
            run_accounts_cases, run_profile_files_cases, run_emulator_cases,
            run_runtime_cases, run_recognition_cases, run_calibrate_cases, run_screens_cases, run_later_cases,
            context_fence_cases]
UNNAMED_ALLOWED = 49      # cases no row names (the settling reads of one scenario); report.json lists them

NOTES = dict(
    format=('Each case is {request:{method, path, body?}, status, body}. A JSON body is the route\'s exact answer '
            '(keys sorted by Flask); a body that is not JSON (the default 500 page an unhandled exception produces in '
            'production, exception propagation off) is {text}; a request whose body is not JSON records the text that '
            'was sent. Ids are aliased in order of appearance; the scenario root is <root>; time is the fixed clock '
            '1800000000 (2027-01-15 08:00 UTC). A case named read_* is the GET a client makes to settle a write; the '
            'name says which write it follows.'),
    run_controls_save=('POST /api/run-controls saves the SAVED run (the profile file), compare-and-set on the file '
                       'revision. Order of the route\'s checks: no usable active profile (400), starter/draft/other '
                       'account (409), context (409), revision (409), then the values (400). The reply is the read\'s '
                       'shape with the new profile_revision. There is no idempotency key: a request whose answer was '
                       'lost is settled by a read, never by sending it again (the identical resend of a committed save '
                       'is refused as stale). A save that raised after the file was written answers a text 500 and '
                       'the read shows it; one that raised before the write answers the same 500 and the read shows '
                       'the old revision. Non-finite numbers (the JSON words for not-a-number and infinity) cannot be '
                       'written in this strict-JSON fixture; the route refuses them with 400 (asserted by the '
                       'generator, not recorded).'),
    history_list=('GET /api/battles?instance=&limit=&offset=&status=. Newest record first (rowid descending); the filter is '
                  'applied before the page; limit is 1..200 and offset >= 0 (400 "Invalid battle pagination"), a text that is not an '
                  'integer is a 400 carrying Python\'s own message, status is one of prepared|active|ended|interrupted (an empty '
                  'text means all). The list is scoped to the emulator and account the request names; there is no total count. '
                  'Pages here use limit 2 over five records: the semantics (final page, past the end) are the same at limit 21.'),
    history_detail=('GET /api/battles/{id}?instance=. {battle, events, context}; a record of another emulator or account is a 404 '
                    '"Battle does not belong to the selected emulator and account". Records are made by the real BattleSession; '
                    'setup reports by interactions.loadout\'s builders, the stats capture by runtime.runlog.clipboard_provenance, '
                    'collection evidence by BattleSession\'s own counting (what it does not count is a case). Evidence of '
                    'another generation cannot be produced by any driver: collection_evidence_of_another_generation_written_'
                    'through_the_ledger puts it there with the ledger\'s own writer to show the page that the record holds it.'),
    run_controls_live=('POST /api/operations/{id}/live-controls records one revisioned controls command for the tracked '
                       'battle: compare-and-set on control_revision, one unapplied change at a time, idempotent by '
                       'idempotency_key (an identical request is answered from its record after the driver or battle '
                       'ended; the same key with other changes is a 409). 400/404/409 mean nothing was recorded; a '
                       'recorded command whose read-back failed answers 500 command_outcome_unknown. The accepted '
                       'cases also record the battle read that lists the command and the key. The command wire states '
                       '(requested, pending, applied, rejected, expired) are in dashboard_contract_v1.json battles_active.'),
)


NOTES.update(
    context_fence=('Review finding F6PE-P02. POST /api/accounts (select and create), /api/account-tier, /api/profile-activate, /api/profile-copy, '
                   '/api/profile-promote, /api/profile-patch and /api/loadout-patch accept an optional `expected_context` {instance, account, profile, serial} '
                   '(exactly these four keys, each text or null; the values GET /api/config names: active_instance, that instance\'s account and serial, '
                   'active_profile). It is the FIRST check after the body is read (before the owner refusal, the validators and the revision checks) and is '
                   'made under the config write lock, which stays held until the handler has written or refused. A mismatch is 409 {ok:false, code:'
                   '\'context_changed\', error, current_context} (null when the configuration names no context at all: an unknown account, a missing config.yaml - the fence only reads, a refusal never seeds it from the example - or a stored shape that is not a configuration) and nothing is written; a field that is present but malformed (not an object, other keys, a '
                   'value that is not text or null, an explicit null) is 400 {ok:false, code:\'invalid_request\', error}; an absent field is the legacy page\'s '
                   'request, answered exactly as before (no fence). A request resent after a lost answer meets the context its own commit made and is refused '
                   'context_changed: nothing is applied twice. POST /api/loadout-patch also carries its own expected_revision (compare-and-set on config.yaml): the context is judged first, so a stale context with any revision is context_changed and only a current context with a stale revision is revision_conflict. Another process editing config.yaml is excluded by no lock (as before).'),
    recognition_reads=('GET /api/wizard/templates | required | scan-plan[?preset=], /api/catalogue/modules, /api/calibrate/status[?operation_id=]. '
                       'The account-less root holds the digit font (10 files every world is seeded with); an account\'s own listing and plan '
                       'count its images only. The module catalogue normally reads the machine\'s backend/catalogue_local.yaml: the cases point it at a file '
                       'of the world (the learned modules of a real install are not part of the contract). The scan plan always lists all 209 targets with '
                       'their status (Missing | Captured; recognition not yet verified | Verified on this emulator | Needs attention: <reason>); `required` '
                       'marks only the blocking images of the named run; a calibrate_report.json that is not valid JSON, not an object, or whose entries are '
                       'not objects with a `rel` verifies nothing (200). Status of an operation shows only artifacts sealed to it: a state of another '
                       'operation empties state, report and manifests and names the artifact in artifact_errors; a shared file that is JSON but not an object '
                       'reads as {}. Refusals of the status route carry codes operation_unknown | operation_kind_mismatch. Setup evidence (setup battle, '
                       'final screen, report entries per target) is echoed as the calibrator wrote it; the route summarises no target gap and no scan metric '
                       '(see NOT_PRODUCIBLE).'),
    calibrate_writes=('POST /api/calibrate/start | observe | apply | stop. EVERY refusal of these routes is {ok:false, code, error[, operation][, missing]}: '
                      'the message is what the route always said, `code` is the stable word to branch on, `operation` (public form) is present when the refusal '
                      'names the operation as it is now (the Stop contract). Codes: invalid_request (400: a body that is not a JSON object, not valid JSON, '
                      'empty on start), invalid_routes | invalid_phases | invalid_watch (400), context_changed, idempotency_key_reused, operation_active '
                      '(the ledger already holds an operation on the device), calibration_running, taps_disabled, navigation_images_missing (with `missing`, '
                      'sorted), modules_not_done, device_owned | action_lock (unchanged), operation_required | operation_unknown | operation_changed | '
                      'not_a_calibration | observations_tracked | starter_profile | profile_missing | profile_changed | restoration_pending | no_observations | '
                      'artifact_unavailable | artifact_changed | artifact_invalid | apply_failed (apply; the last is 400 for a write that failed and 500 for '
                      'anything unexpected, both return the operation to awaiting_apply). Launch commands carry expected_context and idempotency_key (an '
                      'identical retry answers the stored operation, without `phases`, whatever has changed since). Start checks, in order: the action lock; '
                      'the body (must be a JSON object, whatever the content type); routes (400); the receipt replay; owners (409 device_owned); a running '
                      'calibration; taps (unless allow_navigation); phases; missing navigation images; phase e needs phase 1 modules; then the ledger '
                      '(expected_context, another operation owns the device). Observe needs no taps; a body that does not claim to be JSON (or is empty) is an '
                      'empty command, a body that claims to be JSON must be an object; `watch` is validated AFTER the receipt replay (an identical retry '
                      'answers the stored operation) and before the owner checks, and must be a whole number of seconds from 0 to 600 (absent, null or 0: two frames only), anything else is refused, never clamped. Apply: a repeat of an applied '
                      'revision is answered from the record (200); then owners, revision, original context and configuration revision, starter, profile file, '
                      'sealed artifacts, no account observations or a pending module restoration (400, refused before the apply began: the operation is '
                      'unchanged), write failures (400/500 apply_failed, the operation returns to awaiting_apply). A failed or interrupted capture is applied and '
                      'keeps its failure. Stop is cooperative for calibrations (a marker file; status cancelling, stop.state stopping, nothing signalled), is not '
                      'held back by the action lock, and a worker that cannot be verified is released while the lease is free. A worker proven gone is retired '
                      'by the ledger before the revision is compared, so the Stop is refused operation_changed with the retired operation.'),
    recognition_images=('A route that answers pixels is recorded as {binary:{content_type, width, height, pixels_sha256}}: the PNG\'s bytes depend on the '
                        'encoder, the decoded pixels do not. The device shows a synthetic 1080x2560 frame drawn in the generator (gradient, a button-like '
                        'block of integer-exact bars, one flat grey block); nothing was captured. The artwork text badge is drawn with anti-aliased text, so '
                        'only its size and Cache-Control are recorded. GET /api/frame.png remembers the frame under ?ts= (the last 8 tokens) together with the '
                        'page it was fetched for (instance, account, profile, serial); POST /api/template/<rel> crops that exact frame and refuses 409 '
                        'frame_expired (the token is gone) or 409 frame_context_changed (the page changed since: the token stays valid for the page it was '
                        'fetched for). The cropper\'s other refusals keep {ok:false, error}. The provenance of a crop (report entry with the image hash, '
                        'learned rectangle) is read from the file the route wrote, under the dashboard\'s account; it no longer consults the settings singleton. '
                        'Screen recognition (OCR) is a controlled stand-in.'),
    screen_analysis=('POST /api/screen-analysis/start does not consult the process table (the ledger refuses a second operation: 409 operation_active); a '
                     'body must be a JSON object or empty / not claim to be JSON. Every refusal of start, status and frame carries a code (idempotency_key_reused | '
                     'context_changed | operation_active | operation_unknown | operation_kind_mismatch | analysis_not_finished | artifact_unavailable | '
                     'artifact_changed | artifact_invalid); status and frame follow the requested operation, else the latest of the context, else the shared '
                     'files. A running operation reports status running whatever the file says; a file of another operation is not shown (message "belongs to '
                     'another operation" stays in the reply next to status running); failed or interrupted operations are status error with the operation\'s '
                     'message or "Analysis did not complete"; a finished operation whose result was never written is status unavailable. frame.png ignores the '
                     '`revision` query the page may send; with no operation and no file it is 404 no_screenshot.'),
    recognition_later=('Later tools. POST /api/clicker/step answers {ok:true, result} with the worker\'s own verdict inside: result.ok can be false (refused, '
                       'screen changed, click sent but destination not confirmed) under an outer ok:true; a worker that prints nothing is a nested refusal; one '
                       'that prints no JSON or times out is the unknown outcome {ok:false, error:"Check did not finish..."} (HTTP 200). The body must be a JSON '
                       'object (400 invalid_request; so is an action that is not text); `execute` must be the JSON true or false when present (400 invalid_execute '
                       'otherwise, before any permission check) and only true clicks (409 taps_disabled when taps are off). GET /api/clicker/frame with no preview is 404 '
                       'no_preview. GET /api/manifest/contribution downloads text only (verified geometry, counts of excluded entries, discovery candidates); the '
                       'screen object the analyzer writes ({name, candidates}) is read by its name (a name the manifest does not know is "unclassified"), a plain name '
                       'is read as well, and a report or analysis that is not the shape its producer writes is skipped.'),
)

def generate(dash, base, monkeypatch):
    gen = PagesGenerator(dash, base, monkeypatch)
    for family in FAMILIES:
        family(gen)
    return gen.cases


PINNED_PROCESS_CREATED = 1_799_990_000.25      # the creation time every recorded worker identity of the dashboard process gets


def pin_process_identity(value):
    """A receipt names the worker that wrote it - this very process: its pid is pinned by dashboard.pin_processes and its
    creation time (the machine's, the moment pytest started) is pinned here."""
    if isinstance(value, dict):
        pinned = {k: pin_process_identity(v) for k, v in value.items()}
        if pinned.get('pid') == 4242 and type(pinned.get('creation_time')) is float:
            pinned['creation_time'] = PINNED_PROCESS_CREATED
        return pinned
    if isinstance(value, list):
        return [pin_process_identity(v) for v in value]
    return value


def build(dash, base, monkeypatch):
    base = Path(base) / 'contract'
    document = dict(version=1, generated_by='backend/tests/test_dashboard_contract_pages.py', notes=NOTES,
                    cases=dict(generate(dash, base, monkeypatch)))
    return dashboard.alias_ids(pin_process_identity(dashboard.pin_processes(dashboard.scrub(document, base))))


def render(document):
    return dashboard.render(document)


def family_hashes(document):
    return {family: hashlib.sha256(json.dumps(cases, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest().upper()
            for family, cases in document['cases'].items()}


def case_ids(document):
    return dashboard.case_ids(document)


# ---------------------------------------------------------------- coverage
# row -> the cases that satisfy it ("family.case"). A row id is the brief's own (README.md "Missing contract cases
# for the backend generator": G-01..T-02; runs-brief.md section 1: RUN-nn). Filled per page as the families are added.
def keys(family, *cases):
    return [f'{family}.{case}' for case in cases]


SAVE, LIVE = 'run_controls_save', 'run_controls_live'
HL, HD = 'history_list', 'history_detail'
CFG, PR, PP, SP = 'config_state', 'profile_reads', 'profile_patch', 'schedule_plan'
ST = 'settings'
LO, CO, AB = 'loadout_patch', 'collection_policies', 'ability_policies'
AC, PF = 'accounts_write', 'profile_files_write'
EI, EA, ET = 'emulator_inventory', 'emulator_actions', 'emulator_tools'
RS, RD = 'runtime_state', 'runtime_diagnostics'
RR, CW, RI, SA, RL = 'recognition_reads', 'calibrate_writes', 'recognition_images', 'screen_analysis', 'recognition_later'
CF = 'context_fence'
COVERAGE = {
    'RUN-05 saved save: success (switches, numbers, null reset, several paths, run as preset id, shared policy, shopping plan, run with fewer controls)': (
        keys(SAVE, 'read_before_the_first_save', 'saved_switch_off', 'read_after_the_save_holds_the_new_values',
             'saved_numbers_with_the_revision_of_the_last_save', 'saved_switches_and_numbers_in_one_request',
             'saved_null_returns_a_number_to_its_default', 'saved_run_given_as_the_preset_id',
             'saved_with_the_nested_form_the_run_key_and_the_patch_key', 'read_after_several_saves',
             'saved_shopping_plan_v2', 'saved_shopping_switch_off_keeps_the_plan', 'saved_shopping_switch_on_again_with_a_plan',
             'saved_the_first_run_only', 'read_of_the_second_run_after_the_first_was_saved', 'read_of_a_run_with_fewer_controls',
             'saved_a_control_the_run_supports', 'saved_again_with_the_revision_just_read')),
    'RUN-04/06 saved save: refused values (400, nothing saved, the read after is unchanged)': (
        keys(SAVE, 'invalid_below_the_minimum', 'invalid_above_the_maximum', 'invalid_decimal_below_the_minimum',
             'invalid_text_for_a_number', 'invalid_empty_text_for_a_number', 'invalid_true_for_a_number',
             'invalid_number_for_a_switch', 'invalid_text_for_a_switch', 'one_invalid_path_refuses_the_whole_request',
             'read_after_the_refusals_nothing_changed', 'unknown_control', 'unknown_routine', 'path_without_a_field',
             'path_with_too_many_parts', 'path_outside_routines', 'nested_form_with_an_unknown_field',
             'nested_form_with_an_unknown_routine', 'changes_empty', 'changes_a_list', 'changes_text', 'changes_missing',
             'unknown_run', 'combo_is_no_run', 'run_missing', 'run_not_text', 'body_a_list', 'body_not_json', 'body_missing',
             'refused_a_control_the_run_does_not_support', 'refused_the_shopping_plan_the_run_does_not_support',
             'saved_shopping_plan_null_refused', 'saved_shopping_plan_invalid_refused',
             'save_refused_for_a_problem_in_another_run_of_the_profile', 'save_of_a_profile_with_a_problem')),
    'RUN-06 saved save: revision conflict (409, the read after holds the other save)': (
        keys(SAVE, 'stale_revision_another_client_saved_first', 'read_after_the_stale_refusal_holds_the_other_clients_save',
             'stale_revision_is_judged_before_the_values', 'expected_revision_null', 'expected_revision_a_number',
             'expected_revision_empty_text', 'expected_revision_missing')),
    'RUN-06/SR-7 saved save: context conflict (409)': (
        keys(SAVE, 'context_missing', 'context_other_emulator', 'context_other_profile', 'context_other_account',
             'context_with_a_member_missing', 'context_changed_after_the_read',
             'read_after_the_context_changed_names_the_new_profile', 'context_is_judged_before_the_revision')),
    'RUN-06 saved save: read-only profile (starter, scan draft, another account, none selected, file missing) and the action lock': (
        keys(SAVE, 'read_of_the_shipped_starter_is_allowed', 'starter_profile_is_read_only', 'read_of_a_scan_draft_is_allowed',
             'scan_draft_is_read_only', 'read_of_another_accounts_profile_is_allowed', 'another_accounts_profile_is_read_only',
             'read_without_an_active_profile', 'save_without_an_active_profile', 'read_of_a_profile_whose_file_is_missing',
             'save_of_a_profile_whose_file_is_missing', 'action_lock_another_action_in_progress',
             'read_after_the_action_lock_nothing_saved')),
    'RUN-07 saved save: no answer (a 5xx, a lost answer, a lost request) and the read that settles it': (
        keys(SAVE, 'write_failed_nothing_saved_500', 'read_after_the_failed_write_the_revision_is_unchanged',
             'saved_then_the_answer_failed_500', 'read_after_the_unanswered_save_holds_every_sent_value',
             'identical_resend_after_a_committed_save_is_refused_as_stale', 'read_after_a_lost_answer_the_save_is_there',
             'read_after_a_lost_request_nothing_was_saved', 'read_after_a_lost_answer_a_new_revision_without_the_sent_values')),
    'RUN-08 live save: accepted (switch, numbers, null reset, several paths, nested form) and the battle read that lists the key': (
        keys(LIVE, 'accepted_switch_off', 'read_after_the_change_lists_the_command_and_its_key',
             'read_after_the_driver_applied_the_change', 'accepted_numbers_after_the_previous_change_applied',
             'accepted_several_paths_in_one_command', 'accepted_with_the_nested_form',
             'read_after_several_changes_overrides_and_applied_values', 'identical_retry_answered_from_the_record')),
    'RUN-09 live save: what the driver refuses while it is not ready (prepared battle, a change still unapplied, driver gone, battle ended)': (
        keys(LIVE, 'prepared_battle_lists_no_controls_refused', 'second_change_while_the_first_is_not_applied_refused',
             'new_key_refused_the_driver_is_no_longer_active', 'new_key_refused_the_battle_has_ended',
             'identical_retry_answered_from_the_record_after_the_driver_ended',
             'identical_retry_after_the_battle_ended_answered_from_the_record')),
    'RUN-10 live save: no answer, and the refusals that mean nothing was recorded': (
        keys(LIVE, 'admitted_then_the_readback_failed_unknown', 'retry_while_the_readback_still_fails_unknown',
             'read_after_the_unknown_lists_the_key', 'identical_retry_answered_from_the_record_once_the_readback_works',
             'stale_control_revision_refused', 'same_key_with_other_changes_refused', 'stale_generation_refused',
             'unknown_battle_refused', 'unknown_operation_refused', 'replaced_battle_refused',
             'action_lock_another_action_in_progress', 'retry_after_the_lock_was_released_is_recorded',
             'read_after_a_refusal_lists_no_command', 'read_after_the_refusals_nothing_was_recorded')),
    'RUN-11 live save: the server refuses the values the page checks (ranges, types, unknown controls, malformed body)': (
        keys(LIVE, 'invalid_below_the_minimum', 'invalid_above_the_maximum', 'invalid_decimal_below_the_minimum',
             'invalid_text_for_a_number', 'invalid_true_for_a_number', 'invalid_number_for_a_switch', 'unknown_control',
             'unknown_routine', 'path_without_a_field', 'one_invalid_path_refuses_the_whole_command', 'changes_empty',
             'changes_missing', 'control_the_driver_does_not_support', 'battle_id_missing', 'generation_missing',
             'idempotency_key_missing', 'idempotency_key_empty', 'expected_revision_missing', 'expected_revision_text',
             'expected_revision_true', 'body_a_list', 'body_not_json', 'body_missing')),
    'RUN-15 (Later) live reset of one path to the battle\'s starting value': keys(LIVE, 'accepted_null_resets_a_path_to_the_battles_starting_value'),
    # ---- Run history (README H-01, H-02)
    'H-01 status filters (every status, empty text means all, prepared has none, past the filtered rows)': keys(
        HL, 'status_ended', 'status_interrupted', 'status_active', 'status_prepared_none', 'status_ended_past_its_rows_empty',
        'status_ended_second_page_of_one', 'status_empty_text_means_all'),
    'H-01 offset and limit boundaries, the final page and past the end': keys(
        HL, 'first_page', 'second_page', 'final_page_one_row', 'past_the_end_empty', 'limit_one',
        'limit_larger_than_the_rows_returns_all', 'no_instance_uses_the_active_emulator'),
    'H-01 malformed query (limit, offset, status, emulator)': keys(
        HL, 'limit_zero_refused', 'limit_201_refused', 'limit_negative_refused', 'offset_negative_refused', 'limit_text_refused',
        'limit_empty_refused', 'offset_text_refused', 'limit_decimal_refused', 'status_unknown_refused', 'status_upper_case_refused',
        'emulator_unknown_refused'),
    'H-01 other-account and other-emulator isolation (list and detail)': (
        keys(HL, 'beta_sees_only_its_own_record', 'alpha_sees_only_its_own_record', 'no_account_selected_sees_neither', 'other_emulator_has_no_battles')
        + keys(HD, 'detail_of_the_other_accounts_record_is_a_404', 'detail_of_this_accounts_record', 'record_of_another_emulator_404')),
    'H-01 active and prepared details': keys(HD, 'prepared_nothing_observed', 'active_started_entry_observed', 'active_adopted_partial_observation'),
    'H-01 unavailable reads (ledger unreadable, unknown emulator, unknown record)': (
        keys(HL, 'ledger_unreadable_500') + keys(HD, 'detail_ledger_unreadable_500', 'unknown_emulator_refused', 'unknown_record_404')),
    'H-02 started, adopted and partially adopted origin': keys(
        HD, 'active_started_entry_observed', 'active_adopted_partial_observation', 'partial_adoption_links_the_interrupted_record',
        'interrupted_by_the_adopting_driver'),
    'H-02 setup verified, degraded and unknown': keys(
        HD, 'setup_unknown_not_verified_for_this_battle', 'setup_verified', 'setup_verified_global_preset', 'setup_degraded_refused',
        'setup_degraded_module_not_equipped', 'setup_degraded_optional_failed'),
    'H-02 stats capture verified, unverified, failed, pending and missing': keys(
        HD, 'stats_capture_verified', 'stats_capture_unverified_wrong_tier', 'stats_capture_unverified_not_fresh',
        'stats_capture_unverified_not_structured', 'stats_capture_pending', 'stats_capture_failed_with_artifact',
        'stats_capture_failed_no_artifact', 'stats_capture_missing_while_the_battle_is_live',
        'stats_capture_missing_after_the_battle_ended', 'stats_capture_of_an_adopted_battle_stays_unverified'),
    'H-02 sampled collection coverage, what is not counted, and evidence of another generation': keys(
        HD, 'collection_none_observed', 'collection_sampled_confirmations_live', 'collection_sampled_confirmations_ended',
        'collection_unconfirmed_outcomes_not_counted', 'collection_confirmed_with_the_wrong_reason_not_counted',
        'collection_confirmation_older_than_the_battle_not_counted', 'collection_same_confirmation_published_twice_counted_once',
        'collection_evidence_of_another_generation_written_through_the_ledger'),
    'H-02 null wave, time and outcome; unknown reasons; observation gaps': keys(
        HD, 'interrupted_before_any_observation_everything_unknown', 'ended_without_a_final_wave',
        'ended_by_a_surrender_the_driver_started', 'ended_for_a_reason_the_page_may_not_know', 'observation_gap_still_open',
        'observation_gap_closed_after_the_screen_returned', 'ended_after_an_observation_gap'),
}
# Rows whose cases already are in dashboard_contract_v1.json (the Dashboard contract): not copied, referenced.
V1_REFERENCES = {
    'RUN-09 live save: the report is stale / the battle is only prepared / the last change is unapplied (read side)': [
        'battles_active.stale_report', 'battles_active.prepared', 'battles_active.commands_controls_pending_no_path_applied_action_started'],
    'RUN-08/10 command wire states of a controls command (requested, pending with empty and partial applied_paths, applied, rejected, expired)': [
        'battles_active.commands_controls_requested_action_requested', 'battles_active.commands_controls_pending_no_path_applied_action_started',
        'battles_active.commands_controls_pending_some_paths_applied_action_completed', 'battles_active.commands_controls_applied_with_overrides_action_failed',
        'battles_active.commands_controls_rejected_action_rejected', 'battles_active.commands_controls_expired_action_second_key_joined'],
    'RUN-01/02 the run picker and the saved controls read': ['runs.defined_and_undefined_with_labels', 'run_controls.ad_gems_on_floating_off',
                                                            'run_controls.both_off', 'run_controls.unknown_blueprint', 'run_controls.combo_is_no_blueprint'],
}
COVERAGE.update({
    # ---- shared editor reads and writes (README G-01, G-02, G-03)
    'G-01 populated account/loadout config; missing, re-seeded and corrupt file; save and read-after-save': keys(
        CFG, 'populated_accounts_and_loadouts', 'effective_view_of_the_other_account', 'account_missing_from_the_library_refused',
        'file_missing_and_no_example_500', 'file_missing_is_reseeded_from_the_example', 'file_corrupt', 'read_before_the_save',
        'save_accepted', 'read_after_the_save_holds_the_change', 'save_refused_a_list_is_not_a_config', 'save_refused_body_not_json',
        'read_after_the_refusals_is_unchanged'),
    'G-02 profile source, files and list: valid, draft, starter, other account, warnings, errors, missing and unreadable sources': keys(
        PR, 'profiles_list', 'profile_files_active_and_patchable', 'profile_src_valid', 'profile_src_with_validator_warnings',
        'profile_src_with_problems', 'profile_files_with_a_draft_and_the_starter', 'profiles_list_with_a_draft', 'profile_src_of_a_draft',
        'profile_src_of_the_starter', 'profile_files_hide_the_other_accounts_profile', 'profile_src_of_the_other_accounts_profile_is_not_refused',
        'profile_src_unknown_404', 'profile_src_bad_name_400', 'profile_src_not_a_mapping_400', 'profile_src_unreadable_yaml_400',
        'profile_src_empty_file_400', 'profile_src_validator_unavailable_is_reported_not_hidden', 'no_profile_files', 'profiles_list_empty'),
    'G-02 vocabulary, flows and run templates (ok and unsupported)': keys(
        PR, 'vocab_ok', 'vocab_unavailable_is_http_200_with_ok_false', 'vocab_of_the_wrong_type_is_http_200_with_ok_false', 'flows_ok',
        'flows_unavailable_500', 'run_templates_ok'),
    'G-03 profile patch: whole list, append, delete, weekday mapping, coupled plan, whole policy, one policy field': keys(
        PP, 'read_before_the_first_save', 'saved_a_whole_day_list', 'saved_a_block_appended_at_the_end_of_a_list',
        'saved_one_block_deleted_from_a_list', 'saved_a_weekday_mapped_to_a_day_plan', 'saved_a_weekday_mapping_deleted',
        'saved_the_default_day_plan_changed', 'saved_the_whole_plan_days_and_week_together', 'saved_a_whole_gathering_policy',
        'saved_one_field_of_a_policy', 'read_after_the_saves_holds_every_change', 'saved_with_validator_warnings_returned',
        'saved_without_an_expected_revision_is_accepted'),
    'G-03 profile patch: validation failures (windows, counts, times, kinds, tournament cap, empty day/plan, week, policy values), deletes, paths': keys(
        PP, 'block_references_an_unknown_run', 'window_closes_before_it_opens', 'window_closes_when_it_opens', 'count_zero', 'count_negative',
        'count_fraction', 'count_text', 'time_hour_out_of_range', 'time_text', 'block_kind_does_not_match_the_run', 'unknown_block_name',
        'tournament_count_raised', 'two_tournament_blocks_in_one_day', 'day_emptied', 'plan_emptied', 'week_names_an_unknown_day_plan',
        'week_names_an_unknown_weekday', 'policy_field_of_the_wrong_type', 'policy_range_reversed', 'week_default_deleted_leaves_weekdays_unnamed',
        'policy_deleted_while_a_run_uses_it', 'run_deleted_while_a_block_uses_it', 'path_empty', 'list_index_out_of_range', 'value_missing_writes_null',
        'read_after_the_refusals_nothing_changed'),
    'G-03 profile patch: stale revision, starter and draft refusal, unknown profile, malformed body, lock, unreadable file, validator unavailable': keys(
        PP, 'stale_revision_409', 'stale_revision_is_judged_before_the_values', 'read_after_the_stale_refusal_holds_the_other_clients_save',
        'starter_refused_with_a_flag', 'scan_draft_refused', 'unknown_profile_404', 'name_with_a_path_400', 'name_missing_400', 'body_not_json_400',
        'body_a_list_500', 'profile_file_unreadable_400', 'profile_file_not_a_mapping_400', 'validator_unavailable_500', 'action_lock_another_action_in_progress'),
    'G-03 profile patch: write failures, write-then-error, readback, serialized multi-save with a partial result': keys(
        PP, 'write_failed_nothing_saved_500', 'read_after_the_failed_write_the_revision_is_unchanged', 'written_then_the_answer_failed_500',
        'read_after_an_error_that_followed_the_write_holds_the_change', 'identical_resend_after_a_committed_write_is_refused_as_stale',
        'multi_save_first_request_saved', 'multi_save_second_request_saved', 'multi_save_third_request_refused_by_the_validator',
        'read_after_a_partial_batch_holds_the_first_two'),
    'G-03 cross-context limits of the route (names a profile, not the page\'s context)': keys(
        PP, 'another_accounts_profile_is_not_refused_by_this_route', 'the_route_names_a_profile_so_an_active_profile_switch_is_not_noticed',
        'read_names_the_new_active_profile_after_the_switch'),
    # ---- Schedule (README S-01)
    'S-01 scheduler decisions: overlap, exclusive end, midnight split, tournament, changed profile, no plan': keys(
        SP, 'overlapping_windows_the_first_listed_wins', 'window_closed_at_its_exclusive_end_falls_to_the_next',
        'window_open_one_minute_before_its_end_still_wins', 'window_that_opens_later_is_not_yet_eligible',
        'window_written_in_both_days_the_half_covering_now_wins', 'tournament_window_outranks_the_filler_below_it',
        'observed_under_the_active_profile', 'the_active_profile_changed_after_the_observation', 'schedule_status_without_a_plan'),
    'S-01 plan source and patch: missing vs empty plan, plan added, window across midnight written as two blocks': (
        keys(SP, 'profile_without_a_plan_has_no_plan_member', 'profile_with_an_empty_plan_is_a_validator_problem')
        + keys(PP, 'a_plan_added_to_a_profile_that_has_none', 'a_window_across_midnight_is_written_as_two_blocks_and_accepted')),
})
COVERAGE.update({
    # ---- settings (README G-04)
    'G-04 settings read: every module with scope, apply notice, fields and ranges; read-only (starter, draft, other account, none); no policies; unreadable': keys(
        ST, 'populated_account_every_module', 'starter_profile_active_profile_modules_read_only', 'scan_draft_active_profile_modules_read_only',
        'other_accounts_profile_active_profile_modules_read_only', 'no_active_profile_only_machine_and_emulator_modules',
        'profile_without_gathering_policies_has_no_gather_modules', 'profile_not_a_mapping_400', 'profile_unreadable_yaml_400'),
    'G-04 settings save: every module kind (machine, emulator, profile; range, point, integer, number, boolean, enum, string) with the fresh snapshot as readback': keys(
        ST, 'saved_tap', 'saved_device_preview', 'saved_loop', 'saved_missions', 'saved_fleet', 'saved_logging', 'saved_rewards',
        'saved_global_abilities', 'saved_gather_all_on', 'saved_ad_all_on', 'saved_orbit_all_on', 'read_after_every_module_was_saved',
        'saved_although_the_profile_has_an_older_problem_only_new_problems_refuse', 'starter_profile_active_a_machine_module_still_saves'),
    'G-04 settings refusals: ranges, whole numbers, enums, points, booleans, unknown keys and modules, empty and malformed bodies': keys(
        ST, 'integer_with_a_fraction', 'integer_above_the_maximum', 'number_below_the_minimum', 'number_above_the_maximum', 'range_reversed',
        'range_of_three', 'range_needing_whole_numbers_gets_a_fraction', 'boolean_as_text', 'enum_with_an_unknown_option', 'point_outside_the_screen',
        'point_of_three', 'orbit_interval_below_the_minimum', 'ad_window_below_the_minimum', 'unknown_field_for_the_module', 'unknown_module',
        'values_empty', 'values_missing', 'body_a_list', 'body_not_json', 'read_after_the_refusals_nothing_changed',
        'starter_profile_active_a_profile_module_is_refused'),
    'G-04 settings conflicts: stale revision, stale context, switched emulator, action lock': keys(
        ST, 'context_missing', 'context_other_profile', 'context_other_emulator', 'context_other_account', 'revision_missing',
        'stale_revision_another_client_saved_first', 'stale_revision_is_judged_before_the_values', 'stale_revision_is_judged_before_the_module',
        'read_after_the_stale_refusal_holds_the_other_clients_save', 'saved_again_with_the_revision_just_read', 'the_emulator_was_switched_after_the_read',
        'read_after_the_switch_names_the_new_emulator', 'action_lock_another_action_in_progress'),
    'G-04 settings lost-answer outcomes: write failed (a 400), saved then the answer failed (a 500) and the read that settles it': keys(
        ST, 'machine_write_failed_is_a_400_and_nothing_saved', 'profile_write_failed_is_a_400_and_nothing_saved',
        'read_after_the_failed_writes_the_revision_is_unchanged', 'saved_then_the_answer_failed_500', 'read_after_the_unanswered_save_holds_the_value',
        'identical_resend_after_a_committed_save_is_refused_as_stale'),
})
COVERAGE.update({
    # ---- Equipment (README E-01)
    'E-01 loadout save: global preset, category presets, manual cards/guardians, untouched categories, workshop/bot presets, placeholder, advisory': keys(
        LO, 'read_before_the_first_save', 'global_preset_selected', 'category_presets_selected', 'manual_cards_and_guardians',
        'cards_only_the_other_categories_are_left_untouched', 'workshop_and_bot_presets', 'placeholder_body_for_a_loadout_no_run_uses',
        'read_after_the_saves_holds_every_loadout', 'saved_without_an_expected_revision_is_accepted', 'manual_equipment_returns_the_corruption_advisory'),
    'E-01 loadout refusals: not owned (global/category/workshop/cards/guardian/module), mixed global preset, placeholder in use, missing inventory, empty/malformed/unknown': keys(
        LO, 'global_preset_not_on_the_account', 'global_preset_mixed_with_cards', 'module_preset_not_on_the_account',
        'workshop_preset_not_on_the_account', 'cards_preset_not_on_the_account', 'guardian_not_owned', 'module_not_equipped',
        'placeholder_body_for_the_loadout_a_run_uses', 'inventory_missing_the_account_cannot_verify_what_it_equips',
        'a_selection_of_a_preset_with_no_inventory_is_refused', 'body_empty', 'body_a_list', 'body_missing', 'name_unknown_404',
        'name_blank_400', 'name_not_text_400', 'body_not_json', 'read_after_the_refusals_nothing_changed'),
    'E-01 loadout conflicts and failures: revision conflict, lock, validator unavailable, no active profile, write failure, write-then-error, readback': keys(
        LO, 'stale_revision_409', 'an_empty_body_is_judged_before_the_revision', 'stale_revision_is_judged_before_the_name',
        'validator_unavailable_500', 'action_lock_another_action_in_progress',
        'no_active_profile_the_body_is_not_validated_against_any_run', 'write_failed_nothing_saved_500', 'written_then_the_answer_failed_500',
        'read_after_an_error_that_followed_the_write_holds_the_change', 'identical_resend_after_a_committed_write_is_refused_as_stale'),
    # ---- Collection (README C-01)
    'C-01 gathering policy CRUD, run binding, guild spending, orbit geometry, delay and cooldown bounds, chores': keys(
        CO, 'read_before_the_first_save', 'policy_added', 'a_run_bound_to_the_new_policy', 'guild_store_spending_switched_on',
        'guild_store_spending_switched_off_again', 'orbit_geometry_changed', 'orbit_window_longer_than_its_interval_is_accepted',
        'ad_gem_delay_bounds_whole_seconds', 'ad_gem_cooldown_as_a_range', 'retry_cooldown_separate_from_the_collection_cadence',
        'chores_reordered_and_one_switched_off', 'policy_added_that_no_run_uses', 'policy_nothing_uses_deleted',
        'a_run_rebound_to_another_policy', 'the_policy_its_run_left_deleted', 'read_after_the_saves_holds_every_change'),
    'C-01 gathering refusals: unknown keys, wrong types, delays, ad options, orbit values, missing and in-use policy, chores': keys(
        CO, 'policy_with_an_unknown_key', 'ad_gems_as_text', 'delay_fraction', 'delay_reversed', 'delay_negative',
        'delay_missing_makes_the_policy_unusable', 'ad_cooldown_below_the_minimum', 'ad_cooldown_reversed', 'ad_window_below_the_minimum',
        'ad_window_above_the_maximum', 'ad_edge_inset_fraction', 'ad_option_unknown', 'orbit_interval_zero', 'orbit_window_too_long',
        'orbit_retry_below_the_minimum', 'orbit_center_of_three', 'orbit_taps_as_text', 'orbit_unknown_key',
        'run_bound_to_a_policy_that_does_not_exist', 'chore_unknown', 'chore_without_a_name', 'chores_not_a_list',
        'policy_deleted_while_a_run_uses_it', 'a_run_bound_to_a_missing_policy_is_a_problem_the_page_must_show', 'read_after_the_refusals_nothing_changed'),
    # ---- Abilities (README A-01)
    'A-01 Ultimate Weapon baseline and Chain Lightning modes with ranges; rescue arming/watch/immunity; rules appended, edited, reordered, deleted': keys(
        AB, 'read_before_the_first_save', 'uw_policy_added', 'uw_baseline_weapon_switched_off',
        'uw_weapon_the_account_does_not_own_is_allowed_in_a_baseline', 'chain_lightning_mode_always_on',
        'chain_lightning_fleet_marks_with_ranges', 'chain_lightning_off_until_a_wave_range', 'chain_lightning_off',
        'rescue_arming_watch_and_immunity_changed', 'rescue_end_the_sprint_after_second_wind', 'rescue_rule_appended_at_the_end',
        'rescue_rule_cooldown_and_repeat_changed', 'rescue_burst_retaps_changed', 'rescue_rules_reordered', 'rescue_rule_deleted',
        'rescue_policy_added', 'rescue_policy_bound_to_a_run', 'unused_uw_policy_deleted',
        'global_demon_mode_timing_is_a_settings_module_not_a_policy', 'read_after_the_saves_holds_every_change'),
    'A-01 ability refusals: unknown weapons, modes, ranges, arm, bars, thresholds, triggers, actions, buttons, wall/HP mix, missing and in-use policies': keys(
        AB, 'uw_baseline_weapon_unknown', 'uw_baseline_value_not_a_boolean', 'chain_lightning_unknown_mode', 'chain_lightning_mode_missing',
        'chain_lightning_range_reversed', 'chain_lightning_range_of_three', 'chain_lightning_range_as_text', 'chain_lightning_unknown_key',
        'uw_policy_unknown_key', 'rescue_arm_unknown_trigger', 'rescue_watch_negative', 'rescue_immunity_as_text', 'rescue_rule_unknown_bar',
        'rescue_rule_threshold_above_one', 'rescue_rule_samples_zero', 'rescue_rule_unknown_trigger', 'rescue_rule_without_an_action',
        'rescue_rule_unknown_action', 'rescue_rule_unknown_button', 'rescue_rule_throttle_negative', 'rescue_burst_retaps_zero',
        'rescue_policy_mixes_wall_and_hp_bars', 'rescue_rule_trigger_with_a_bar_and_a_collapse_together', 'rescue_rules_not_a_list',
        'run_bound_to_a_rescue_policy_that_does_not_exist', 'run_bound_to_a_uw_policy_that_does_not_exist',
        'rescue_policy_deleted_while_a_run_uses_it', 'uw_policy_deleted_while_a_run_uses_it', 'read_after_the_refusals_nothing_changed'),
    'A-01 unowned and unverified abilities: advisory (unverified, no wall) vs problem (not owned), and the binding refused': keys(
        AB, 'abilities_not_verified_is_an_advisory_not_a_problem', 'no_wall_confirmed_is_an_advisory_not_a_problem',
        'abilities_the_account_does_not_own_are_bound_to_a_run_is_a_problem', 'binding_another_run_to_an_unowned_ability_is_refused'),
})
COVERAGE.update({
    # ---- Profiles (README P-01, P-02)
    'P-01 accounts: create (fresh and importing the current one), select, labels, read-after': keys(
        AC, 'read_before_any_account', 'create_a_fresh_account', 'read_after_create_names_the_account_active',
        'profile_files_after_create_hold_the_new_profile', 'create_an_account_importing_the_current_one', 'select_an_existing_account',
        'read_after_select', 'create_without_a_label_uses_the_id'),
    'P-01 accounts: duplicate and malformed ids, unknown account, existing profile file, missing current profile, malformed body': keys(
        AC, 'create_a_duplicate_id', 'select_an_unknown_account', 'id_with_a_space', 'id_empty', 'id_missing', 'id_not_text', 'id_with_a_path',
        'id_too_long', 'profile_file_of_the_new_account_already_exists', 'body_not_json', 'import_current_but_the_current_profile_is_missing',
        'read_after_the_refusals_alpha_is_still_the_only_account'),
    'P-01 accounts: owner refusal, action lock, create/save partial failure and readback': keys(
        AC, 'refused_while_a_runner_owns_the_device', 'read_after_the_owner_refusal_nothing_created', 'action_lock_another_action_in_progress',
        'create_then_the_config_save_failed_leaves_the_profile_file', 'read_after_the_failed_create_no_account',
        'profile_files_after_the_failed_create_list_the_orphan', 'retry_with_the_same_id_is_refused_because_the_orphan_exists',
        'a_different_id_creates_normally'),
    'P-01 account tier: operator provenance, bounds and types, starter/none, validator, owner, write failure, other account': keys(
        AC, 'read_before_the_tier', 'tier_saved_by_the_operator', 'read_after_the_tier',
        'profile_source_after_the_tier_records_the_operator_as_provenance', 'tier_lowest', 'tier_highest', 'tier_zero', 'tier_21',
        'tier_fraction', 'tier_text', 'tier_true', 'tier_null', 'tier_missing', 'tier_body_not_json', 'read_after_the_refusals_tier_unchanged',
        'tier_of_the_starter_is_refused', 'tier_with_no_profile_file_is_refused', 'tier_with_no_active_profile_is_refused',
        'tier_refused_because_the_profile_has_a_problem', 'tier_refused_while_a_runner_owns_the_device', 'tier_write_failed_500',
        'read_after_the_failed_tier_write_unchanged', 'tier_of_another_accounts_profile_is_not_refused_by_this_route'),
    'P-02 profile copy: starter and own profiles, collision, overwrite, starter/draft/unknown, bad names, lock; nothing is activated': keys(
        PF, 'files_before_the_copy', 'copy_the_starter_to_a_new_profile', 'files_after_the_copy_list_it_and_copy_activates_nothing',
        'copy_one_of_your_own_profiles', 'copy_onto_an_existing_profile_is_refused', 'copy_onto_an_existing_profile_with_overwrite',
        'copy_onto_the_starter_is_refused', 'copy_from_a_scan_draft_is_refused', 'copy_from_an_unknown_profile', 'copy_to_a_draft_name_is_refused',
        'copy_to_a_bad_name', 'copy_without_a_name', 'copy_body_not_json', 'copy_action_lock_another_action_in_progress'),
    'P-02 profile activation (separate from copy): own, starter, none; draft, invalid, unknown, other account, owner, write failure': keys(
        PF, 'activate_another_profile', 'files_after_the_activation_name_the_active_profile', 'activate_the_starter',
        'activate_none_unbinds_the_profile', 'activate_none_again_says_nothing_was_bound', 'files_after_unbinding_have_no_active_profile',
        'activate_an_unknown_profile', 'activate_a_scan_draft', 'activate_a_profile_with_problems_is_refused', 'activate_a_name_with_a_path',
        'activate_a_name_that_is_not_text', 'activate_body_not_json', 'activate_refused_while_a_runner_owns_the_device',
        'files_after_the_owner_refusal_unchanged', 'activate_another_accounts_profile_is_refused', 'activate_write_failed_500',
        'files_after_the_failed_activation_unchanged'),
    'P-02 draft promotion: success with returned problems, collision and overwrite consent, starter/draft/base refusals, failed write, no activation': keys(
        PF, 'promote_a_draft_over_the_starter', 'profile_source_of_the_promoted_profile_carries_the_draft_player_block',
        'files_after_the_promotion_activate_nothing', 'promote_onto_an_existing_profile_is_refused',
        'promote_onto_an_existing_profile_with_overwrite', 'promote_with_the_draft_given_with_its_suffix', 'promote_to_the_starter_name_is_refused',
        'promote_without_a_draft', 'promote_draft_name_missing', 'promote_name_missing', 'promote_to_a_draft_name',
        'promote_over_a_base_that_does_not_exist', 'promote_over_a_draft_base', 'promote_a_draft_with_an_empty_player_block',
        'promote_body_not_json', 'promote_action_lock_another_action_in_progress', 'promotion_returns_the_problems_it_does_not_enforce_them',
        'promote_write_failed_400_receipt_failed', 'files_after_the_failed_promotion_have_no_new_profile'),
    'P-02 scan-operation promotion: operation revision and context, receipt replay and readback, capture kept after a failed apply, owner refusal': keys(
        PF, 'promote_the_result_of_a_finished_scan', 'identical_retry_is_answered_from_the_receipt',
        'the_same_scan_with_another_name_is_a_different_request', 'the_scan_operation_after_the_promotion', 'stale_expected_revision',
        'operation_unknown', 'operation_id_without_a_revision', 'draft_of_another_account_scan', 'profile_changed_after_scanning',
        'operation_that_is_not_a_scan', 'scan_still_running_is_not_final', 'promotion_refused_while_a_runner_owns_the_device',
        'apply_failed_the_receipt_is_failed', 'the_scan_operation_after_the_failed_apply_still_holds_its_capture', 'retry_after_the_failed_apply'),
})
COVERAGE.update({
    # ---- Emulators (README M-01, M-02, M-03)
    'M-01 emulator inventory: several candidates and no automatic choice, one candidate, configured up, probed adb, token serial, folded console token, daemon-only device, no serial yet': keys(
        EI, 'two_running_vms_the_configured_one_is_down_no_automatic_choice',
        'configured_serial_differs_from_the_live_vm_one_candidate_is_suggested', 'configured_device_is_up_nothing_is_suggested',
        'the_configured_adb_is_probed_and_lists_its_devices', 'token_serial_configured_its_port_cannot_be_probed',
        'one_vm_listed_twice_the_console_token_is_folded_into_also_seen', 'daemon_device_without_an_inventory_is_the_only_candidate',
        'no_serial_configured_yet_placeholder'),
    'M-01 screen resolution: portrait reference, portrait other size, landscape, text instead of a frame, no adb server, bad serial': keys(
        EI, 'resolution_portrait_reference', 'resolution_portrait_not_the_reference_size', 'resolution_landscape_is_not_portrait',
        'resolution_the_device_answered_text_not_a_frame', 'resolution_no_adb_server', 'resolution_serial_not_a_device_serial_400',
        'resolution_serial_missing_400'),
    'M-02 adopt: connected, saved but not connected, attached transport verified or silent, expected-instance and placeholder conflicts, bad serials, owner, lock, write failure': keys(
        EA, 'adopt_a_serial_saved_and_connected', 'wizard_state_after_the_adopt_holds_the_receipt', 'config_after_the_adopt_names_the_serial',
        'adopt_saved_but_not_connected', 'adopt_an_attached_transport_verified_over_the_adb_socket',
        'adopt_an_attached_transport_that_does_not_answer', 'adopt_a_placeholder_instance_that_already_has_a_serial_is_refused',
        'adopt_the_instance_changed_since_the_scan', 'adopt_a_serial_that_is_not_a_serial', 'adopt_without_a_serial',
        'adopt_a_serial_that_is_not_text', 'adopt_body_not_json', 'adopt_the_active_instance_does_not_exist_in_config',
        'adopt_refused_while_a_runner_owns_the_device', 'adopt_action_lock_another_action_in_progress',
        'adopt_the_config_could_not_be_written_500', 'config_after_the_failed_adopt_is_unchanged'),
    'M-02 launch: accepted with the boot pipeline, without a configured instance, on a fresh install; manager failure; unsupported; owner; manager error': keys(
        EA, 'launch_a_mumu_vm_with_a_configured_instance_starts_the_boot_pipeline', 'launch_a_vm_no_instance_uses_skips_the_boot_pipeline',
        'launch_on_a_fresh_install_writes_the_serial_it_launched', 'launch_the_manager_reported_a_failure', 'launch_an_unsupported_emulator',
        'launch_mumu_without_an_index_500', 'launch_mumu_with_an_index_that_is_not_a_number_500', 'launch_bluestacks_with_a_bad_key',
        'launch_bluestacks_that_is_not_installed', 'launch_body_not_json', 'launch_mumu_but_its_manager_is_not_installed',
        'launch_refused_while_a_runner_owns_the_device', 'launch_the_manager_could_not_be_started_500'),
    'M-02 BlueStacks preparation: changed, no-op, running, missing conf, unknown instance, bad key': keys(
        EA, 'prepare_changes_the_adb_switch_and_the_framebuffer', 'prepare_again_changes_nothing', 'prepare_refused_while_bluestacks_is_running',
        'prepare_without_bluestacks_conf', 'prepare_an_unknown_instance', 'prepare_a_bad_instance_key', 'prepare_without_a_key', 'prepare_body_not_json'),
    'M-03 connection tools: idle, license required, 202 accepted, already downloading, progress, ready, error, retry, owner, lock': keys(
        ET, 'tools_idle_before_any_install', 'install_without_the_license_400', 'install_license_must_be_true_not_a_word',
        'install_license_false_400', 'install_body_not_json', 'tools_still_idle_after_the_refusals', 'install_accepted_202_the_download_starts',
        'tools_downloading_at_zero', 'install_again_while_downloading_is_answered_not_restarted', 'tools_downloading_with_progress',
        'install_runs_to_the_end', 'tools_installed_after_the_install', 'install_failed_the_request_was_still_accepted',
        'tools_error_state_after_a_failed_install', 'install_can_be_retried_after_an_error',
        'install_refused_while_a_runner_owns_the_device', 'install_action_lock_another_action_in_progress'),
})
V1_REFERENCES.update({
    'M-02 reconnect (200, offline, error, owned) and M-01/M-03 wizard emulators scan, wizard state sections and tools installed/not installed': [
        'reconnect.accepted_device_state_device', 'reconnect.answered_with_another_device_state', 'reconnect.answered_offline_after_the_retries',
        'reconnect.refused_while_a_runner_is_listed', 'reconnect.adb_connect_raised', 'wizard_emulators.instances_with_names_and_ports',
        'wizard_emulators.none', 'wizard_emulators.scan_error', 'wizard_state.after_scan', 'wizard_state.all_sections', 'wizard_tools.installed',
        'wizard_tools.not_installed'],
})
COVERAGE.update({
    # ---- Runtime (README T-01, T-02)
    'T-01 /api/runtime: build current, changed on disk, unreadable, no snapshot; capabilities': keys(
        RS, 'idle_server_build_matches_the_source_on_disk', 'server_started_before_the_source_changed_restart_needed',
        'disk_source_cannot_be_read_so_freshness_is_unknown', 'no_snapshot_could_be_taken_at_start_nothing_to_compare'),
    'T-01 workers (alive, proven gone, unverifiable, accepted without a worker), persistence operations, stale and unreadable process discovery': keys(
        RS, 'worker_alive_and_verified', 'worker_recorded_but_proven_gone_until_the_refresher_retires_it',
        'worker_that_cannot_be_verified_is_unknown_not_dead', 'operation_accepted_but_no_worker_spawned_yet',
        'a_profile_write_is_listed_as_a_persistence_operation_not_a_worker', 'process_discovery_stale', 'process_discovery_unreadable'),
    'T-02 diagnostics events: exact id/kind/instance/time/failure filters, limit, empty': keys(
        RD, 'no_log_folder_yet_nothing_scanned', 'every_event_oldest_first_with_log_coordinates', 'filter_by_kind', 'filter_by_operation',
        'filter_by_battle', 'filter_by_command', 'filter_by_request_and_trace', 'filter_by_attempt_matches_a_claim_attempt_too',
        'filter_by_sweep', 'filter_by_window', 'filter_by_offer', 'filter_by_instance_uses_the_folder_unless_the_record_names_one',
        'filter_by_the_instance_a_record_names', 'filters_combined_none_match', 'failures_only_includes_refusals_and_unconfirmed',
        'since_a_time', 'limit_one_returns_the_newest_and_says_truncated', 'limit_1000_is_accepted'),
    'T-02 diagnostics bounds, malformed and unreadable logs, writer health, invalid queries': keys(
        RD, 'a_log_larger_than_the_per_file_bound_is_read_from_its_tail', 'more_files_than_the_bound_the_newest_are_read_and_truncation_is_reported',
        'malformed_lines_are_counted_and_a_half_written_last_line_is_truncation',
        'one_file_cannot_be_read_the_others_are_returned_and_the_error_is_listed', 'writer_health_reports_failed_writes',
        'unknown_filter_refused', 'limit_zero_refused', 'limit_1001_refused', 'limit_text_refused', 'since_text_refused',
        'since_negative_refused', 'since_not_finite_refused', 'failures_must_be_0_or_1', 'filter_longer_than_200_characters_refused'),
})
NOT_PRODUCIBLE = {
    'T-01 build identity of the machine': (
        'dashboard_contract_v1.json notes exclude it and this contract replaces the server snapshot with one over a synthetic source tree: '
        'the real snapshot is the checkout\'s own fingerprint (backend/runtime/build_info.py snapshot()), a machine identity.'),
    'C-01 collection quota and reset evidence': (
        'No producer: the saved-run and battle projections publish the routines\' cadence and last outcomes, and the daily flags '
        'live in scheduling/daystate; no endpoint returns a per-routine quota or reset time (README C-01: "Quota/reset evidence requires '
        'an explicit producer; do not invent success from daily flags").'),
    'A-01 retired rules': (
        'The validator has no notion of a retired rule; a rule action this version does not know is refused as an unknown action '
        '(case rescue_rule_unknown_action) or listed in the profile problems (a_rule_with_an_action_this_version_does_not_support).'),
    'S-01 per-block remaining quota and next-start values': (
        'No API publishes them: backend/control/schedule_status.py read() returns winner/observed_winner/next_clock_boundary only '
        '(its docstring: "No eligibility is computed here") and the Schedule brief says to fixture them only after a producer exists.'),
}
COVERAGE.update({
    'R-01 template inventory: only the digit font, captured by folder, requested-and-not-found, account isolation': keys(
        RR, 'templates_captured_listed_by_folder_and_name', 'templates_of_the_first_account',
        'templates_of_the_second_account_do_not_include_the_first', 'templates_only_the_digit_font_is_present',
        'templates_requested_and_not_found_are_listed_but_not_completeness'),
    'R-01 required images (none/some captured) and the module catalogue (learned on this install)': keys(
        RR, 'module_catalogue_nothing_learned', 'module_catalogue_one_module_learned_on_this_install',
        'required_images_none_captured', 'required_images_some_captured'),
    "R-01 scan plan mapping/interface, the run's blocking images required, unknown run, one image captured": keys(
        RR, 'scan_plan_after_one_image_was_captured', 'scan_plan_for_a_run',
        'scan_plan_for_an_unknown_run', 'scan_plan_marks_the_blocking_images_of_the_run_required',
        'scan_plan_without_a_run'),
    'R-01 scan plan evidence: verified/stale/unverified copy/other pixels, learned rectangle, corrupt report, cross-account isolation': keys(
        RR, 'scan_plan_of_the_first_account', 'scan_plan_of_the_second_account_shows_nothing_of_the_first',
        'scan_plan_separates_verified_stale_unverified_copy_and_a_report_for_other_pixels', 'scan_plan_shows_a_learned_rectangle_and_makes_the_target_automatic',
        'scan_plan_with_a_corrupt_report_verifies_nothing', 'scan_plan_with_a_report_that_is_valid_json_but_not_an_object_verifies_nothing', 'scan_plan_with_report_entries_that_are_not_what_the_calibrator_writes_verifies_nothing'),
    'R-01 calibrate status: failed evidence, foreign/changed artifacts, unknown and other-workflow operations, corrupt shared files, cross-account, untracked worker, observation, taps': keys(
        RR, 'calibrate_status_corrupt_shared_files_read_as_nothing', 'calibrate_status_shared_files_that_are_json_but_not_objects_read_as_nothing', 'calibrate_status_failed_keeps_the_error_and_the_evidence_that_was_sealed',
        'calibrate_status_of_another_workflow_409', 'calibrate_status_of_the_first_account',
        'calibrate_status_of_the_second_account_shows_nothing_of_the_first', 'calibrate_status_report_changed_after_it_was_sealed_is_unavailable',
        'calibrate_status_running_observation_names_its_mode_and_no_taps', 'calibrate_status_running_worker_that_belongs_to_no_operation',
        'calibrate_status_shared_files_of_an_untracked_calibration', 'calibrate_status_state_of_another_operation_empties_the_read_and_names_the_error',
        'calibrate_status_taps_not_allowed', 'calibrate_status_unknown_operation_409',
        'calibrate_status_without_an_operation_reads_the_latest_of_the_context'),
    'R-02 calibrate status of an awaiting-apply, aborted and restoration-required calibration (partial/awaiting-apply/restoration/abort)': keys(
        RR, 'calibrate_status_aborted_by_a_person_keeps_the_partial_evidence', 'calibrate_status_awaiting_apply_with_the_sealed_evidence',
        'calibrate_status_restoration_required_with_the_restore_file_present'),
    'R-06 retained setup evidence: the setup battle (active, finished) and the final screen': keys(
        RR, 'calibrate_status_setup_battle_active_no_final_screen_yet', 'calibrate_status_setup_battle_finished_and_home_verified_with_target_evidence'),
    'R-02 start: accepted modes (basic, default steps, fresh/overwrite/navigation, bootstrap, flows, battle-only, routes, selected run, equipped)': keys(
        CW, 'start_basic_phases_accepted', 'start_battle_only_without_flows_is_ignored',
        'start_bootstrap_flows_battle_only', 'start_bootstrap_needs_no_navigation_images',
        'start_bootstrap_routes_home_to_cards_and_back', 'start_bootstrap_with_the_action_capture_flows',
        'start_equipped_phase_after_modules_are_done', 'start_fresh_overwrite_and_navigation_consent_reach_the_worker',
        'start_names_the_run_the_learning_is_for', 'start_without_an_expected_context_is_accepted',
        'start_without_phases_uses_the_six_default_steps_and_no_fresh_flag'),
    'R-02 start: receipt, replay, same key other command, retry of a settled or failed calibration': keys(
        CW, 'start_for_a_later_retry', 'start_retry_after_the_calibration_failed_answers_the_failed_operation',
        'start_retry_with_the_same_key_answers_the_same_operation', 'start_same_key_with_other_phases_is_refused'),
    'R-02 start: context, owner, running calibration, consent (taps), missing images, phase and route validation': keys(
        CW, 'start_action_lock_another_action_in_progress', 'start_bootstrap_taps_off_409',
        'start_context_changed_409', 'start_equipped_phase_before_modules_are_done_is_refused',
        'start_expected_context_that_is_not_an_object_409', 'start_only_separators_400',
        'start_phases_list_is_read_as_its_text_400', 'start_phases_that_is_not_text_400',
        'start_profile_changed_409', 'start_routes_empty_400',
        'start_routes_not_a_list_400', 'start_routes_not_contiguous_400',
        'start_routes_not_ending_at_home_400', 'start_routes_repeated_id_400',
        'start_routes_unknown_id_400', 'start_routes_with_battle_only_400',
        'start_routes_with_observe_400', 'start_routes_with_the_flows_capture_400',
        'start_routes_without_bootstrap_400', 'start_taps_off_409',
        'start_taps_off_with_the_navigation_consent_is_accepted', 'start_unknown_phase_400',
        'start_while_a_calibration_is_running_is_refused', 'start_while_a_run_owns_the_device_409',
        'start_while_a_scan_owns_the_device_409', 'start_while_an_observation_is_running_409',
        'start_while_the_collector_owns_the_device_409', 'start_with_only_the_base_images_409_lists_the_rest',
        'start_without_the_navigation_images_409'),
    'R-02 start: malformed bodies': keys(
        CW, 'start_body_is_not_valid_json_400', 'start_empty_body_400', 'start_body_not_json_400', 'start_body_that_is_a_number_400', 'start_body_that_is_null_400',
        'start_body_that_is_a_list_400'),
    'R-02 observe: accepted, watch bounds (30, clamped 600, negative, text, fraction), no taps, selected run, receipt/replay': keys(
        CW, 'observe_accepted', 'observe_names_the_run_it_is_for',
        'observe_negative_watch_is_refused_400', 'observe_watch_601_is_refused_400', 'observe_watch_0_is_no_watch', 'observe_retry_with_the_same_key_answers_the_same_operation',
        'observe_same_key_with_a_watch_is_refused', 'observe_taps_off_is_accepted_it_never_taps',
        'observe_watch_30_seconds', 'observe_watch_above_600_is_refused_400', 'observe_watch_600_is_the_longest_accepted',
        'observe_watch_that_is_a_fraction_is_refused_400', 'observe_watch_that_is_a_boolean_is_refused_400', 'observe_watch_that_is_text_is_refused_400', 'observe_watch_that_is_a_number_in_text_is_refused_400'),
    'R-02 observe: context, owner, running calibration/observation, action lock, malformed bodies': keys(
        CW, 'observe_action_lock_another_action_in_progress', 'observe_body_not_json_is_read_as_an_empty_command',
        'observe_body_is_not_valid_json_400', 'observe_body_that_is_a_list_400', 'observe_context_changed_409',
        'observe_while_a_calibration_is_running_409', 'observe_while_a_run_owns_the_device_409',
        'observe_while_an_observation_is_running_is_refused'),
    'R-02 apply: applied, replay after a lost answer, wall bar, selected run readiness, observation, failed/interrupted capture applied with the failure kept, saved observations': keys(
        CW, 'apply_after_a_failed_capture_keeps_the_failure_on_the_operation', 'apply_after_an_interrupted_capture_keeps_the_interruption',
        'apply_again_after_the_restoration_is_done', 'apply_again_after_the_write_failure',
        'apply_an_observation_is_applied_like_a_calibration', 'apply_awaiting_apply_is_applied',
        'apply_profile_write_fails_400', 'apply_resend_after_a_failed_capture_was_applied',
        'apply_resend_after_a_lost_answer_is_answered_from_the_record', 'apply_saved_observations_of_no_operation',
        'apply_unexpected_failure_500', 'apply_with_a_selected_run_returns_its_readiness',
        'apply_with_the_wall_bar_region_writes_it_to_the_configuration'),
    'R-02 apply: revision, operation, artifact, context, config, profile, starter, owner, restoration conflicts and malformed bodies': keys(
        CW, 'apply_a_cancelled_calibration_409', 'apply_action_lock_another_action_in_progress',
        'apply_after_another_profile_became_active_409', 'apply_after_the_configuration_changed_409',
        'apply_after_the_device_changed_409', 'apply_after_the_profile_was_edited_409',
        'apply_an_operation_that_is_not_a_calibration_409', 'apply_body_not_json_is_read_as_an_empty_command',
        'apply_body_is_not_valid_json_400', 'apply_body_that_is_a_list_400', 'apply_other_revision_after_the_apply_is_refused',
        'apply_revision_that_is_text_409', 'apply_saved_observations_that_belong_to_an_operation_409',
        'apply_saved_observations_while_an_operation_is_tracked_409', 'apply_saved_observations_without_a_saved_file_400',
        'apply_saved_observations_without_account_observations_400', 'apply_stale_revision_409',
        'apply_state_changed_after_it_was_sealed_409', 'apply_state_missing_409',
        'apply_state_of_another_operation_409', 'apply_state_without_account_observations_400',
        'apply_unknown_operation_409', 'apply_while_a_run_owns_the_device_409',
        'apply_while_the_calibration_runs_409', 'apply_while_the_module_restoration_is_pending_400',
        'apply_while_the_original_modules_are_not_restored_409', 'apply_with_no_profile_file_400',
        'apply_with_the_starter_profile_active_409', 'apply_without_naming_an_operation_409',
        'apply_without_the_revision_409'),
    'R-02 stop: asks the worker to stop, repeat, released unverified worker, observation, lock bypass': keys(
        CW, 'stop_a_worker_that_cannot_be_verified_is_released_while_the_lease_is_free', 'stop_again_while_it_is_stopping_signals_nothing',
        'stop_an_observation_like_a_calibration', 'stop_is_not_held_back_by_another_action_in_progress',
        'stop_running_calibration_asks_the_worker_to_stop'),
    'R-02 stop: refusals (no operation, unknown, stale, finished, restoration, worker exited) and malformed bodies': keys(
        CW, 'stop_a_calibration_that_finished_409', 'stop_after_the_worker_exited_the_operation_is_retired_and_the_stop_refused_409',
        'stop_body_not_json_is_read_as_an_empty_command', 'stop_body_that_is_a_list_is_read_as_an_empty_command',
        'stop_stale_revision_409', 'stop_unknown_operation_409',
        'stop_while_the_modules_must_be_restored_409_nothing_is_signalled', 'stop_without_naming_the_operation_409'),
    'R-02 reads that settle the writes: running, stopping, exited, applied, failed, refused, write failed, restoration, latest of the context, wall bar configuration': keys(
        CW, 'read_the_applied_calibration_by_operation', 'read_the_calibration_after_the_refused_apply',
        'read_the_calibration_after_the_refused_apply_nothing_changed', 'read_the_calibration_after_the_write_failed',
        'read_the_calibration_that_needs_its_modules_restored', 'read_the_calibration_that_was_asked_to_stop',
        'read_the_calibration_whose_worker_exited', 'read_the_configuration_after_the_wall_bar_apply',
        'read_the_failed_capture_after_the_apply', 'read_the_latest_calibration_of_the_context_after_a_lost_answer',
        'read_the_running_calibration_by_operation', 'read_the_running_observation_by_operation'),
    'R-03 frame.png: token, no token, display, ignored serial, warning stripped, bad display, not a PNG, capture failed, offline': keys(
        RI, 'frame_png_capture_failed_502', 'frame_png_device_offline_502',
        'frame_png_display_that_is_not_a_number_400', 'frame_png_ignores_a_serial_the_page_names',
        'frame_png_of_a_display_the_page_names', 'frame_png_remembered_under_the_token',
        'frame_png_that_is_not_a_png_502', 'frame_png_with_an_emulator_warning_before_the_pixels_is_stripped',
        'frame_png_without_a_token_is_not_remembered'),
    'R-03 cropper save: crop of the cached frame, truncation, overwrite consent, newest frame, provenance and screen not recognised/recorded': keys(
        RI, 'save_a_box_with_fractions_is_truncated', 'save_a_crop_of_the_cached_frame',
        'save_from_a_frame_fetched_for_another_account_409', 'save_from_a_frame_fetched_for_another_emulator_409', 'save_from_the_same_frame_back_on_the_account_it_was_fetched_for',
        'save_a_name_with_a_backslash_is_read_as_a_folder_separator', 'save_from_the_newest_frame',
        'save_over_an_existing_template_with_overwrite', 'save_over_an_existing_template_without_the_overwrite_flag_409',
        'save_when_the_provenance_cannot_be_recorded_the_file_is_still_written_ok_true', 'save_when_the_screen_cannot_be_recognised_still_saves_with_no_screen'),
    'R-03 cropper refusals: bounds, flat colour, no box, name, frame token expired/unknown/missing, decode, write failure, lock, malformed bodies': keys(
        RI, 'save_a_body_that_is_a_list_400', 'save_a_body_that_is_not_json_400',
        'save_a_box_below_the_frame_400', 'save_a_box_outside_the_frame_400',
        'save_a_box_smaller_than_6_pixels_400', 'save_a_box_that_is_null_400',
        'save_a_box_that_is_text_400', 'save_a_box_with_a_missing_side_400',
        'save_a_box_with_a_negative_corner_400', 'save_a_box_with_no_area_400',
        'save_a_flat_colour_box_400', 'save_a_name_that_climbs_out_of_templates_400',
        'save_a_name_that_is_not_a_png_400', 'save_a_name_with_a_drive_400',
        'save_a_name_without_a_folder_400', 'save_action_lock_another_action_in_progress',
        'save_from_a_cached_frame_that_does_not_decode_500', 'save_from_a_frame_that_left_the_cache_409',
        'save_from_a_frame_token_that_was_never_fetched_409', 'save_when_the_png_cannot_be_written_500',
        'save_without_a_box_400', 'save_without_a_frame_token_409'),
    'R-03 saved template reads and the template list/scan plan after a save': keys(
        RI, 'read_a_captured_template', 'read_a_template_name_that_is_not_allowed_403',
        'read_a_template_that_was_not_captured_404', 'read_a_template_with_another_extension_403',
        'read_the_saved_template', 'read_the_scan_plan_after_a_save_with_no_screen_learns_no_rectangle',
        'read_the_scan_plan_after_the_provenance_failed_nothing_is_verified', 'read_the_scan_plan_after_the_save_shows_the_cut_screen_and_its_verification',
        'read_the_template_list_after_the_names', 'read_the_template_list_after_the_save'),
    'R-03 artwork: asset library, manifest mapping, text badge, nothing known (204)': keys(
        RI, 'artwork_a_text_badge_even_when_a_library_exists', 'artwork_a_text_badge_for_a_control_the_game_draws_as_text',
        'artwork_from_the_asset_library_prefers_the_sprite', 'artwork_from_the_manifest_mapping_wins_over_the_name',
        'artwork_indexed_file_missing_204', 'artwork_library_index_unreadable_204',
        'artwork_nothing_known_for_the_target_204', 'artwork_the_library_has_no_image_of_that_name_204'),
    'R-04 screen analysis start: accepted, replay, receipt conflicts, context, owner, lock, malformed, worker not started': keys(
        SA, 'read_the_operation_of_the_failed_start', 'start_accepted',
        'start_action_lock_another_action_in_progress', 'start_body_not_json_is_read_as_an_empty_command',
        'start_body_is_not_valid_json_400', 'start_body_that_is_a_list_400', 'start_context_changed_409',
        'start_retry_of_a_failed_start_answers_the_failed_operation', 'start_retry_with_the_same_key_answers_the_same_operation',
        'start_same_key_with_another_command_is_refused', 'start_when_the_worker_cannot_be_started_is_a_text_500',
        'start_while_an_analysis_is_running_is_refused', 'start_while_another_operation_owns_the_device_409',
        'start_without_a_key_or_a_context_is_accepted'),
    'R-04 screen analysis status: idle, running with progress, done, no match, ambiguous, unknown screen, error, interrupted, unavailable, retained old result, cross-account': keys(
        SA, 'status_corrupt_shared_file_reads_as_idle', 'status_done_from_the_shared_file_of_an_untracked_analysis',
        'status_done_on_a_screen_that_could_not_be_told_apart', 'status_done_operation_whose_result_was_never_written_is_unavailable',
        'status_done_with_matches_and_an_ambiguous_one', 'status_done_without_any_match',
        'status_error_written_by_the_worker_in_the_shared_file', 'status_failed_operation_is_an_error_with_its_message',
        'status_failed_without_a_message_says_it_did_not_complete', 'status_idle_nothing_was_ever_analysed',
        'status_interrupted_operation_is_an_error_even_with_a_result_in_the_file', 'status_new_operation_running_does_not_show_the_previous_result',
        'status_of_another_workflow_409', 'status_of_the_first_account',
        'status_of_the_second_account_shows_nothing_of_the_first', 'status_result_changed_after_it_was_sealed_is_unavailable',
        'status_running_before_the_worker_wrote_anything', 'status_running_with_the_progress_of_the_matching',
        'status_unknown_operation_409', 'status_without_an_operation_reads_the_latest_of_the_context'),
    'R-04 screen analysis frame: by operation, revision ignored, unfinished, unsealed, changed, unknown/other workflow, shared file, none': keys(
        SA, 'frame_changed_after_it_was_sealed_409', 'frame_ignores_a_revision_the_page_holds_that_is_not_the_operations',
        'frame_of_a_finished_analysis_by_its_operation', 'frame_of_an_analysis_with_no_saved_screenshot_409',
        'frame_of_an_unfinished_analysis_409', 'frame_of_an_unknown_operation_409',
        'frame_of_another_workflow_409', 'frame_of_the_shared_file_when_no_operation_exists',
        'frame_with_no_operation_and_no_file_404', 'frame_without_an_operation_is_the_latest_of_the_context'),
    'R-05 clicker actions and frame preview': keys(
        RL, 'actions_listed', 'frame_preview_that_was_never_written_404',
        'frame_preview_written_by_the_clicker'),
    'R-05 clicker step: dry run, nested refusal under ok:true, uncertain execution, unknown outcome, context/owner/taps/lock refusals, malformed': keys(
        RL, 'step_action_lock_another_action_in_progress', 'step_another_account_400',
        'step_another_instance_400', 'step_body_not_json_is_read_as_an_empty_command_400',
        'step_action_that_is_not_text_400', 'step_body_is_not_valid_json_400', 'step_body_that_is_a_list_400', 'step_dry_run_needs_no_tap_permission',
        'step_dry_run_verifies_the_target_and_clicks_nothing', 'step_empty_body_400',
        'step_execute_clicked_but_the_destination_was_not_confirmed', 'step_execute_clicks_and_confirms_the_destination',
        'step_execute_given_as_a_number_is_refused_400', 'step_execute_given_as_null_is_refused_400', 'step_execute_given_as_text_is_refused_400', 'step_execute_given_as_text_with_taps_off_is_refused_400_before_the_taps_check', 'step_execute_the_screen_changed_before_the_click',
        'step_execute_with_taps_off_409', 'step_position_not_learned_yet_nothing_to_click',
        'step_the_check_refused_is_ok_true_outside_and_ok_false_inside', 'step_the_worker_printed_nothing',
        'step_the_worker_printed_something_that_is_not_json_is_an_unknown_outcome', 'step_the_worker_timed_out_is_an_unknown_outcome',
        'step_unknown_action_400', 'step_while_a_run_owns_the_device_409',
        'step_without_an_action_400'),
    "R-05 manifest contribution: export boundaries, excluded entries, discovery candidates, corrupt inputs, the analyzer's screen object": keys(
        RL, 'manifest_contribution_exports_verified_geometry_and_counts_what_it_excluded', 'manifest_contribution_ignores_an_analysis_that_is_not_done',
        'manifest_contribution_lists_discovery_candidates_from_a_done_analysis_of_a_known_screen', 'manifest_contribution_names_an_unknown_screen_unclassified',
        'manifest_contribution_with_a_corrupt_analysis_has_no_candidates', 'manifest_contribution_with_a_corrupt_report_has_no_targets',
        'manifest_contribution_with_the_screen_object_the_analyzer_writes_lists_candidates', 'manifest_contribution_with_a_screen_the_analyzer_could_not_tell_apart_is_unclassified', 'manifest_contribution_with_an_analysis_that_is_not_an_object_has_no_candidates', 'manifest_contribution_with_a_report_that_is_not_an_object_has_no_targets', 'manifest_contribution_skips_report_entries_that_are_not_what_the_calibrator_writes', 'manifest_contribution_without_a_report_has_no_targets'),
})

V1_REFERENCES.update({
    'R-01 runs and readiness (ready, image row, config row, module restoration, check raised, setup required) and the four calibrate-status states': [
        'runs.ready', 'runs.not_ready_image_row', 'runs.not_ready_config_row', 'runs.not_ready_module_restoration', 'runs.readiness_check_raised',
        'runs.setup_required_edit_run', 'runs.setup_required_apply_scan', 'runs.setup_required_battle_setup', 'runs.combo_entry',
        'runs.defined_and_undefined_with_labels', 'readiness.ready_with_context', 'readiness.not_ready_second_wind', 'readiness.setup_required',
        'readiness.unknown_preset', 'calibrate_status.idle', 'calibrate_status.running_with_steps',
        'calibrate_status.failed_setup_unverified_final_screen', 'calibrate_status.restore_pending'],
})
NOT_PRODUCIBLE.update({
    'R-06 targeted gap evidence for Range, First Perk, module and rare-dialog targets, and comparable scan metrics': (
        'No producer: the calibrator records report entries per target (calibrate_report.json) and the setup battle / final screen in its state '
        '(player/flow_capture.py _save_setup_battle, player/calibrate.py record_final_screen), and GET /api/calibrate/status echoes them (cases '
        'calibrate_status_setup_battle_*, calibrate_status_restoration_required_*, scan_plan_separates_*). Nothing in backend/ names a "gap" for '
        'those targets, summarises targeted results or records a scan duration/metric to compare (grep of backend/player, backend/control: no '
        'first_perk, rare_dialog, scan_metrics or comparable_*); README R-06 says "when their producer exists" and the screens brief keeps '
        'roadmap item 9 open: a UI fixture cannot close the live gate.'),
})
COVERAGE.update({
    # ---- Profiles review finding F6PE-P02: the context fence of the context-dependent writes
    'F6PE-P02 a write composed for the context in force is written (the context the page reads from GET /api/config)': keys(
        CF, 'read_config_the_page_context_comes_from', 'tier_with_the_matching_context_is_written', 'read_after_the_matching_tier',
        'copy_with_a_null_account_in_the_context_is_written'),
    'F6PE-P02 every context-dependent route refuses 409 context_changed after a switch, writes nothing, names the current context': keys(
        CF, 'read_config_after_another_client_switched_the_account', 'accounts_create_composed_for_alpha_is_refused_after_the_switch',
        'accounts_select_composed_for_alpha_is_refused_after_the_switch', 'account_tier_composed_for_alpha_is_refused_after_the_switch',
        'profile_activate_composed_for_alpha_is_refused_after_the_switch', 'profile_copy_composed_for_alpha_is_refused_after_the_switch',
        'profile_promote_composed_for_alpha_is_refused_after_the_switch', 'profile_patch_composed_for_alpha_is_refused_after_the_switch',
        'loadout_patch_composed_for_alpha_is_refused_after_the_switch', 'read_after_the_refusals_beta_tier_unchanged',
        'profile_files_after_the_refusals_nothing_was_created', 'read_after_the_refusals_no_account_was_created',
        'copy_for_an_account_that_is_not_bound_is_refused', 'tier_when_the_configuration_names_an_unknown_account_is_refused',
        'read_config_after_another_client_switched_the_account_for_the_loadout', 'loadout_composed_for_alpha_is_refused_with_its_expected_revision',
        'loadout_with_a_stale_context_and_a_stale_revision_is_told_the_context_changed', 'read_config_after_the_loadout_refusals_nothing_was_written'),
    'F6PE-P02 (R10-P01, R10-P03) a refusal reads and never seeds: a missing config.yaml, an empty or list document, a selected instance that is text each answer 409 context_changed with current_context null and write nothing': keys(
        CF, 'tier_when_config_yaml_is_missing_is_refused_and_creates_nothing', 'tier_when_config_yaml_is_empty_is_refused',
        'tier_when_config_yaml_is_a_list_is_refused', 'tier_when_config_yaml_is_a_selected_instance_that_is_text_is_refused'),
    'F6PE-P02 /api/loadout-patch (Equipment): the matching context is written with its expected_revision and the read shows it': keys(
        CF, 'read_config_before_the_loadout_save', 'loadout_with_the_matching_context_is_written', 'read_config_after_the_matching_loadout_holds_it'),
    'F6PE-P02 /api/loadout-patch: a present but malformed expected_context (explicit null included) is a coded 400 that writes nothing': keys(
        CF, 'loadout_expected_context_null_is_refused_not_read_as_absent', 'loadout_expected_context_not_an_object',
        'loadout_expected_context_missing_the_serial', 'loadout_expected_context_with_an_unknown_key', 'loadout_expected_context_serial_not_text',
        'read_config_after_the_malformed_loadout_requests_unchanged'),
    'F6PE-P02 /api/loadout-patch: the context is judged before the revision (a current context with a stale revision is revision_conflict), and an absent field is the legacy request': keys(
        CF, 'loadout_for_the_current_context_with_a_stale_revision_is_a_revision_conflict', 'loadout_without_the_field_is_not_fenced_the_legacy_page',
        'read_config_after_the_legacy_loadout_beta_holds_it'),
    'F6PE-P02 a present but malformed expected_context is a coded 400 (an explicit null included) and writes nothing': keys(
        CF, 'tier_expected_context_null_is_refused_not_read_as_absent', 'tier_expected_context_not_an_object',
        'tier_expected_context_missing_the_serial', 'tier_expected_context_with_an_unknown_key', 'tier_expected_context_serial_not_text',
        'accounts_expected_context_null_is_refused', 'read_after_the_malformed_requests_beta_tier_unchanged'),
    'F6PE-P02 an absent field is the legacy request (not fenced); the context is judged before the owner refusal; a resent switch is refused': keys(
        CF, 'tier_without_the_field_is_not_fenced_the_legacy_page', 'read_after_the_legacy_tier_beta_holds_it',
        'stale_tier_while_a_runner_owns_the_device_is_told_the_context_changed',
        'current_tier_while_a_runner_owns_the_device_is_refused_by_the_owner', 'account_switch_composed_for_alpha_is_committed',
        'the_same_request_resent_after_a_lost_answer_is_refused', 'read_after_the_retry_beta_is_active'),
})
FAMILY_ROWS = {CF: 'F6PE-P02', SAVE: 'RUN-04..07', LIVE: 'RUN-08..11', HL: 'H-01', HD: 'H-01, H-02', CFG: 'G-01', PR: 'G-02', PP: 'G-03', SP: 'S-01', ST: 'G-04', LO: 'E-01', CO: 'C-01', AB: 'A-01', AC: 'P-01', PF: 'P-02', EI: 'M-01', EA: 'M-02', ET: 'M-03', RS: 'T-01', RD: 'T-02', RR: 'R-01, R-02, R-06', CW: 'R-02', RI: 'R-03', SA: 'R-04', RL: 'R-05'}


def fixture_document():
    assert FIXTURE.exists(), f'run with {REGENERATE}=1 to publish it'
    return json.loads(FIXTURE.read_text(encoding='utf-8'))


def test_every_row_is_covered_or_explained():
    document = fixture_document()
    present = case_ids(document)
    required = {case for cases in COVERAGE.values() for case in cases}
    assert not required - present, f'rows name cases that are not in the fixture: {sorted(required - present)}'
    assert not set(NOT_PRODUCIBLE) & set(COVERAGE), 'a row is both covered and declared not producible'
    for row, cases in COVERAGE.items():
        assert cases, f'row {row!r} names no case'
        assert len(cases) == len(set(cases)), f'row {row!r} names a case twice'
    # every family of the fixture belongs to a row group (a family nobody asked for is a documented decision, not drift)
    assert set(document['cases']) == set(FAMILY_ROWS), set(document['cases']) ^ set(FAMILY_ROWS)
    # the cases no row names are the scenario's own settling reads and sibling refusals (listed in the report)
    unnamed = sorted(present - required)
    assert len(unnamed) <= UNNAMED_ALLOWED, f'{len(unnamed)} cases are named by no row: {unnamed[:12]}'


def test_the_rows_that_live_in_the_dashboard_contract_are_there():
    v1 = json.loads(dashboard.FIXTURE.read_text(encoding='utf-8'))
    present = case_ids(v1)
    missing = {case for cases in V1_REFERENCES.values() for case in cases} - present
    assert not missing, f'dashboard_contract_v1.json lacks: {sorted(missing)}'


# The families published so far, in generation order. Ids are aliased in order of appearance, so inserting or
# reordering a family changes the ids (and the hash) of every family after it: new families are appended here.
PUBLISHED_ORDER = ['run_controls_save_cases', 'run_controls_live_cases', 'run_history_cases', 'run_profile_cases', 'run_schedule_cases', 'run_settings_cases',
                   'run_equipment_cases', 'run_collection_cases', 'run_abilities_cases',
                   'run_accounts_cases', 'run_profile_files_cases', 'run_emulator_cases', 'run_runtime_cases',
                   'run_recognition_cases', 'run_calibrate_cases', 'run_screens_cases', 'run_later_cases', 'context_fence_cases']


CODED_PATHS = frozenset({'/api/calibrate/start', '/api/calibrate/observe', '/api/calibrate/apply', '/api/calibrate/stop', '/api/calibrate/status',
                          '/api/screen-analysis/start', '/api/screen-analysis/status', '/api/screen-analysis/frame.png'})


def test_every_refusal_of_the_recognition_routes_carries_a_code():
    """A client branches on `code`: a 4xx/5xx JSON answer of these routes without one is a defect in the route, not a case to record.
    (A body that is {text} is the default error page an unhandled exception produces; none of the cases of these routes is one for a
    refusal.)"""
    missing = [f'{family}.{name}' for family, cases in fixture_document()['cases'].items() for name, case in cases.items()
               if case['request']['path'].split('?')[0] in CODED_PATHS and case['status'] >= 400 and 'text' not in case['body'] and 'code' not in case['body']]
    assert not missing, missing


def test_the_families_are_generated_in_a_fixed_order():
    assert [family.__name__ for family in FAMILIES][:len(PUBLISHED_ORDER)] == PUBLISHED_ORDER


def test_the_published_page_contract_matches_what_the_routes_answer(dash, tmp_path, monkeypatch):
    generated = build(dash, tmp_path / 'first', monkeypatch)
    text = render(generated)
    for leak in (str(tmp_path), str(tmp_path).replace('\\', '\\\\'), tmp_path.as_posix(),
                 str(Path(dash.__file__).parents[1]), str(Path(dash.__file__).parents[1]).replace('\\', '\\\\')):
        assert leak not in text, 'a machine path leaked into the contract'
    assert 'NaN' not in text and 'Infinity' not in text
    assert render(build(dash, tmp_path / 'second', monkeypatch)) == text, 'the contract differs between two runs'
    target = os.environ.get(OUTPUT)
    if target:
        Path(target).parent.mkdir(parents=True, exist_ok=True)
        Path(target).write_bytes(text.encode('utf-8'))
        pytest.skip(f'contract written to {target}; the committed fixture was not compared')
    if os.environ.get(REGENERATE):
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_bytes(text.encode('utf-8'))
        pytest.skip('fixture regenerated: review the diff and tell the UI author')
    assert FIXTURE.exists(), f'run with {REGENERATE}=1 to publish it'
    assert json.loads(FIXTURE.read_text(encoding='utf-8')) == generated
