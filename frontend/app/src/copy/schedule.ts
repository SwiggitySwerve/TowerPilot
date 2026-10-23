import { entry, made } from './entry.ts';

export const schedule = {
  space: made(' '),
  pageName: entry('Schedule'),
  intro: entry(
    'Saved run blocks and their priority. Saving changes future scheduler loading; it never starts, stops or ends a battle.',
  ),
  scope: entry('Saving: whole plan and weekday mapping in this profile.'),
  target: entry('Emulator / account / profile'),
  unknownTarget: entry('Select an emulator and profile before editing a schedule.'),
  noProfile: entry('No active profile. Choose, copy or promote a profile in Profiles.'),
  missing: entry(
    'This saved profile has no plan. The scheduler uses its legacy rules; no schedule hours are reported here.',
  ),
  missingInactive: entry(
    'This saved profile has no plan. Its legacy rules apply if it is activated and loaded. The active scheduler is unchanged.',
  ),
  /** F6-11 RL8 (classic Plan tab "add a plan"). */
  startPlan: entry(
    'Start a day plan',
    'Drafts one day plan used every day of the week, holding one block that runs the run you choose. Choose its block kind, then Save schedule. A saved plan replaces the legacy rules.',
  ),
  startPlanInactive: entry(
    'Start a day plan',
    'Drafts one day plan used every day of the week, holding one block that runs the run you choose. Choose its block kind, then Save schedule. These saved rules apply if this profile is activated and loaded; the active scheduler is unchanged.',
  ),
  startRun: entry('Run for the first block'),
  startNoRun: entry('Add a run in Runs first: every plan block names a run.'),
  started: entry('Day plan started in your draft. Choose the block kind, then save.'),
  /** F6-11 RL8 (classic Plan tab "remove"): delete the whole plan section. */
  removePlan: entry(
    'Remove the day plan',
    'Deletes the whole plan from this profile. The scheduler then uses its legacy rules instead. Removing it never starts, stops or ends a battle; you can start a new day plan afterwards.',
  ),
  removePlanInactive: entry(
    'Remove the day plan',
    'Deletes the whole plan from this saved profile. Its legacy rules apply if it is activated and loaded. The active scheduler is unchanged.',
  ),
  removeTitle: entry('Remove the day plan from this profile?'),
  removeBody: entry(
    'Every day plan and the weekday mapping are deleted from the saved profile. The scheduler then uses its legacy rules. Nothing starts or stops now.',
  ),
  removeInactiveBody: entry(
    'Deletes every day plan and weekday mapping from this saved profile. Its legacy rules apply if it is activated and loaded. The active scheduler is unchanged.',
  ),
  removeConfirm: entry('Remove day plan'),
  removeUnavailable: {
    dirty: entry('Save or discard your changes first.'),
    revision: entry('The profile revision has not been read.'),
    reading: entry('Wait for the saved plan read.'),
    checking: entry('Wait while the emulator, account and profile are checked.'),
    sending: entry('Wait for this save answer.'),
    unknown: entry('Check the unknown save before removing the plan.'),
    reconcile: entry('Read and reconcile the saved revision first.'),
  },
  removed: entry(
    'Day plan removed. The scheduler uses its legacy rules from its next load; this is not confirmation of that load.',
  ),
  removedInactive: entry(
    'Day plan removed from this saved profile. The active scheduler is unchanged.',
  ),
  readRemoved: entry('Readback confirms the day plan is removed.'),
  /** F6-11-P2-04: what a confirmed removal click did, before any answer. */
  removeChecking: entry(
    'Checking that this emulator, account and profile are still selected before removing the day plan.',
  ),
  removeRequested: entry(
    'Removal of the day plan requested. Waiting for its answer; nothing is confirmed yet.',
  ),
  removeSending: entry('Removing the day plan… Nothing is confirmed until the answer arrives.'),
  removeUnknown: entry(
    'Day plan removal outcome unknown. Read the saved plan; do not resend the request.',
  ),
  removeRefused: entry('Day plan removal refused. The saved plan is unchanged.'),
  /** F6-11-P2-01: a Save or Remove click whose click-time context check sent nothing. */
  notSent: {
    target_missing: entry(
      'Not sent: the editing target is no longer a listed, editable profile. Your draft stays with its original profile. Choose a profile in Profiles.',
    ),
    target_unconfirmed: entry(
      'Not sent: the editing target could not be confirmed just now. Your draft is kept. Read the profile list in Profiles before trying again.',
    ),
    context_unconfirmed: entry(
      'Not sent: the selected emulator, account and profile could not be confirmed just now. Nothing was changed and your draft is kept. Try again.',
    ),
    context_changed: entry(
      'Not sent: the emulator, account or profile changed after this page was read. Nothing was changed; your draft stays with the profile it was made for.',
    ),
  },
  empty: entry(
    'This plan has no blocks. It is invalid; an empty plan does not enable fallback scheduling.',
  ),
  noBlocks: entry('This day has no blocks. Save will ask the server to validate this empty day.'),
  reading: entry('Reading saved plan…'),
  readError: entry('Saved plan could not be read for this target. The draft is kept.'),
  savedSource: entry('Saved profile revision'),
  compare: entry('Compare the last read saved plan'),
  baseRevision: entry('Draft starting revision'),
  days: entry('Named day plans'),
  priority: entry(
    'Order is priority: the first eligible block wins. Until is exclusive. Split a cross-midnight window into blocks on both days.',
  ),
  dayPlan: entry('Day plan'),
  run: entry('Saved run'),
  kind: entry('Block kind'),
  after: entry('From (HH:MM)'),
  until: entry('Until (HH:MM, exclusive)'),
  count: entry('Runs/day (blank = unlimited)'),
  blankTimes: entry(
    'Blank From means midnight; blank Until means the rest of the day. Run counts are per block per day.',
  ),
  quota: entry('Remaining quota: not reported'),
  nextStart: entry('Next start: not reported'),
  add: entry('Add block'),
  up: entry('Move up'),
  down: entry('Move down'),
  remove: entry('Delete block'),
  addHint: entry('Add copies the first block; edit the copy before saving.'),
  addUnavailable: entry('There is no saved block to copy. Repair or choose a profile in Profiles.'),
  week: entry('Weekday mapping'),
  weekHint: entry(
    'A blank weekday inherits Default. Default must name a plan unless every weekday has an explicit plan.',
  ),
  inherited: entry('Use Default'),
  defaultRequired: entry('Choose a default plan'),
  weekLabels: {
    default: entry('Default'),
    monday: entry('Monday'),
    tuesday: entry('Tuesday'),
    wednesday: entry('Wednesday'),
    thursday: entry('Thursday'),
    friday: entry('Friday'),
    saturday: entry('Saturday'),
    sunday: entry('Sunday'),
  },
  editRun: entry('Edit run in Runs'),
  profiles: entry('Open Profiles'),
  returnSchedule: entry('Return to Schedule'),
  save: entry('Save schedule'),
  discard: entry('Discard schedule draft'),
  discardTitle: entry('Discard this schedule draft?'),
  discardBody: entry(
    'Replace this target’s entire draft with the last read saved plan, including edits in other day plans.',
  ),
  cancel: entry('Keep editing'),
  refresh: entry('Read saved plan and status'),
  reconcile: entry('Use read revision; keep my draft'),
  reconcileHint: entry(
    'Read the saved profile, compare it with your draft, then explicitly use its revision before another Save. Nothing is resent.',
  ),
  dirty: entry('Unsaved schedule draft'),
  clean: entry('No unsaved changes'),
  saveUnavailable: {
    clean: entry('Edit a block or weekday mapping before saving.'),
    reading: entry('Wait for the saved plan read.'),
    checking: entry('Wait while the emulator, account and profile are checked.'),
    sending: entry('Wait for this save answer.'),
    unknown: entry('Check the unknown save before saving again.'),
    reconcile: entry('Read and reconcile the saved revision before saving again.'),
    revision: entry('The profile revision has not been read.'),
  },
  sending: entry('Saving schedule… New typing stays in your draft.'),
  confirmed: entry('Saved schedule. This is not confirmation of scheduler reload.'),
  partial: entry(
    'The saved answer differs from the submitted plan. Your draft is kept; read the saved profile before reconciling.',
  ),
  refused: entry('Schedule save refused. Your draft is kept.'),
  unknown: entry(
    'Schedule save outcome unknown. Read the saved profile; do not resend the request.',
  ),
  readApplied: entry('Readback confirms the submitted plan is saved.'),
  readUnchanged: entry('Readback shows the starting revision unchanged. The save was not applied.'),
  validation: entry('Profile validation and save details'),
  warnings: entry('Saved profile warnings'),
  observed: entry('Observed scheduler choice'),
  observedProfile: entry('Observed active profile:'),
  editingProfile: entry('Plan for:'),
  unavailable: entry('Scheduler observation unavailable'),
  stale: entry('Last observation is stale; no current winner or next check is confirmed.'),
  noWinner: entry('No eligible block reported'),
  notRunning: entry('Scheduler is not reported running'),
  unknownEmulator: entry('Emulator is unknown to this schedule report'),
  observedAt: entry('Observed at (Unix seconds)'),
  previousWinner: entry('Previously observed choice'),
  timezone: entry('Scheduler timezone / UTC offset'),
  nextCheck: entry('Next check (clock proposal)'),
  noCheck: entry('No next clock check reported'),
  handoff: entry(
    'A clock check does not promise a run start. Handoffs wait for a natural run boundary, including tournament runs.',
  ),
  observedReason: entry('Reported reason'),
  notReported: entry('Not reported'),
  block: (position: number) => made(`Block ${position}`),
  moved: (position: number) => made(`Block moved to position ${position}.`),
  deleted: entry('Block deleted from draft. Focus moved to the next block or Add block.'),
  added: entry('Block added to draft.'),
};
