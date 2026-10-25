import { entry, made } from '../entry.ts';
import type { CopyText } from '../text.ts';

/** "12 m", "30 s", "2 h": a whole interval, for saved routine settings. */
function interval(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole % 3600 === 0 && whole >= 3600) return `${String(whole / 3600)} h`;
  if (whole % 60 === 0 && whole >= 60) return `${String(whole / 60)} m`;
  return `${String(whole)} s`;
}

/** "1 h 12 m", "21 s": a countdown, from whole seconds. */
function duration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${String(whole)} s`;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  return hours > 0 ? `${String(hours)} h ${String(minutes)} m` : `${String(minutes)} m`;
}

/** One gem routine of a saved run, as the source line says it. */
export interface RoutineWords {
  readonly enabled: boolean;
  readonly intervalSec: number | null;
}

function routinePhrase(name: string, routine: RoutineWords | null): string {
  if (routine === null) return `${name} not reported`;
  if (!routine.enabled) return `${name} off`;
  return routine.intervalSec === null
    ? `${name} on`
    : `${name} every ${interval(routine.intervalSec)}`;
}

/**
 * The Game input and Gem harvesting slots of the Control region (spec 3.2,
 * 3.6.2, 3.6.3, 3.7; F-017 to F-032, F-036; deck IN-01 to IN-09, GM-01 to
 * GM-33, GM-44).
 */
export const control = {
  title: entry('Control'),
  input: {
    /** IN-01: the Setting pill's values. */
    setting: {
      allowed: entry('Allowed'),
      off: entry('Off'),
      unknown: entry('Unknown'),
    },
    allow: entry('Allow game input'),
    /** Spec 3.6.3: the Seen now lines, by core's line code. */
    lines: {
      cant_read_input_setting: entry(
        "can't read the input setting",
        'The last config read failed or did not report whether automation may tap this emulator.',
      ),
      earlier_turn_on_no_answer: entry(
        'an earlier turn-on has no answer; taps may be allowed',
        'A request to allow game input was sent and its answer never arrived, so taps may be allowed now.',
      ),
      turn_off_not_confirmed: entry('turn-off not confirmed'),
      automation_input_stopped: entry(
        'automation input stopped',
        'Your turn-off answer said input stopped, and a later fresh read confirmed it.',
      ),
      turned_off_not_yet_confirmed: entry(
        'turned off; not yet confirmed by a fresh read',
        'The turn-off answer says input stopped. A status read that started after it has not confirmed it yet.',
      ),
      no_automation_using_input: entry(
        'no automation is using game input',
        'A fresh, complete read lists no automation and no holder of the emulator.',
      ),
      cant_tell_whats_running: entry(
        "can't tell what's running",
        'The status read failed, is stale or did not report its ownership completely.',
      ),
      taps_may_be_allowed: entry(
        'taps may still be allowed',
        'No backend field reports input actually being delivered, so this never says Running.',
      ),
      input_revocation_not_confirmed: entry(
        'input revocation not confirmed',
        'The Setting reads Off, but no read confirms that automation input is revoked.',
      ),
    },
    /** I3: "turn-off not confirmed for {collector}". */
    notConfirmedFor: (count: number): CopyText =>
      made(
        count === 1
          ? 'turn-off not confirmed for the gem collector'
          : `turn-off not confirmed for ${String(count)} gem collectors`,
      ),
    /** I3 with failed steps (S-044). */
    stepFailed: (step: string): CopyText =>
      made(
        step === 'lease_state'
          ? "turn-off not confirmed: couldn't check the device lease"
          : step === 'revoke_input'
            ? 'turn-off not confirmed: revoking input failed'
            : 'turn-off not confirmed: a step failed',
      ),
    /** IN-02 to IN-09: why Turn input off is offered (S-006, INV-2). */
    offReasons: {
      taps_allowed: entry('Automation may tap this emulator.'),
      setting_unknown: entry("The input setting can't be read, so taps may be allowed."),
      enable_unresolved: entry('An earlier turn-on has no answer.'),
      harvest_not_reported: entry("This server doesn't report whether automation input is revoked"),
      status_unknown: entry("The last status read can't tell what's running."),
      automation_may_run: entry('Automation is listed or recorded and its input is not revoked.'),
      automation_listed: entry('Automation is listed or recorded.'),
      input_not_idle: entry('No fresh read confirms that game input is idle.'),
    },
    allowReasons: {
      request_in_flight: entry('Sending'),
    },
  },
  gem: {
    /** GM-01, GM-02, GM-44: the Your choice pill. */
    choice: {
      on: entry('On'),
      off: entry('Off'),
      not_set: entry('Not set'),
      unknown: entry('Unknown'),
      from_before_turn_on: entry(
        'Off (from before your Turn on)',
        'This Off is not newer than the On you turned on, so it is an older record; Pause stays available.',
      ),
    },
    /** Spec 3.6.2: the Seen now lines, by core's line code. */
    lines: {
      harvest_unreadable: entry(
        "harvesting state can't be read",
        'The status read did not carry a readable harvesting record.',
      ),
      collecting_gems: entry('collecting gems'),
      started_by_collect_only: entry('started by Collect gems only'),
      gem_routines_off: entry('gem routines off for this battle'),
      stop_not_confirmed: entry('stop not confirmed'),
      starting: entry('starting'),
      waiting_to_track_battle: entry(
        'waiting to track a battle',
        'The collector has no battle it observes; the game may still be in one.',
      ),
      collector_state_unknown: entry(
        'collector state unknown',
        'The collector is recorded, but its report is stale, invalid or its worker is not confirmed alive.',
      ),
      run_collects_gems: entry('the run collects gems itself'),
      run_not_collecting: entry(
        "harvesting waits while the run uses the emulator; the run isn't collecting gems",
      ),
      another_process_holds: entry('harvesting waits: another process holds the emulator'),
      another_install_holds: entry('harvesting waits: another install holds the emulator'),
      run_gems_unknown: entry("can't tell whether the run collects gems"),
      handing_over: entry('handing over to your run'),
      collector_start_due: entry('collector start is due'),
      nothing_starts_collector: entry('Nothing here will start the collector'),
      harvest_scheduler_failing: entry('the harvest scheduler is failing'),
      retry_time_not_reported: entry('retry time not reported'),
      no_gem_collection: entry('no gem collection running'),
      state_unknown: entry("can't tell what harvesting is doing"),
    },
    /** The line for the collector this dashboard found running at its start, by the server's code. */
    collectorAtStart: {
      adopted: entry('The collector that was running when the dashboard started is kept'),
      will_stop: entry(
        'The collector that was running when the dashboard started is being stopped',
      ),
      dead: entry('The collector from before this dashboard start had already stopped'),
      unverified: entry("A collector from before this dashboard start can't be checked"),
      untracked: entry(
        'A collector this dashboard did not start is running and was not taken over',
      ),
      other: entry('A collector from before this dashboard start was found'),
    },
    retryingIn: (seconds: number): CopyText => made(`retrying in ${duration(seconds)}`),
    /** G4c: the holder's PID, as the record names it. */
    holderPid: (pid: number): CopyText => made(`PID ${String(pid)}`),
    /** G5d: the cause for each blocked `code` (S-037). */
    blocked: {
      collector_failing: entry('Stopped retrying after repeated failures'),
      context_changed: entry(
        'The active emulator or account changed since harvesting was turned on',
      ),
      emulator_offline: entry('The emulator is not connected'),
      input_revoked: entry('Game input is turned off'),
      policy_invalid: entry("The chosen run's gem settings can't be used"),
      digits_missing: entry("The run's settings were refused"),
      setup_battle_unresolved: entry(
        "Starting collection is blocked: setup's test battle wasn't confirmed",
      ),
      taps_disabled: entry('Automation may not tap this emulator'),
      other: entry('Harvesting is blocked'),
    },
    /** GM-20 to GM-22, F-025, F-026. */
    sourcePicker: entry('Gem settings from'),
    unnamedRun: entry('Run without a name'),
    sourceRoutines: (adGems: RoutineWords | null, floatingGems: RoutineWords | null): CopyText =>
      made(`${routinePhrase('ad gems', adGems)}, ${routinePhrase('floating gems', floatingGems)}`),
    sourceNotRead: entry('saved settings not read yet'),
    sourceUnreadable: entry("saved settings can't be read"),
    sourceChanged: entry('changed since you turned it on'),
    savedSettings: entry('Saved settings in Runs'),
    sourceInvalid: entry("This run's gem settings can't be used"),
    /** GM-20, GM-31: the actions. */
    turnOn: entry('Turn on'),
    turnOnAgain: entry('Turn on again'),
    /** GM-32, GM-33: why Turn on is disabled. */
    turnOnReasons: {
      choice_unknown: entry("Your choice can't be read"),
      source_missing: entry('No saved run to take gem settings from'),
      source_invalid: entry("The chosen run's gem settings can't be used"),
      source_pending: entry("Waiting for the run's saved settings"),
      source_unreadable: entry("The run's saved settings can't be read"),
      gem_routines_off: entry('This run has both gem routines off'),
      context_unknown: entry("The server didn't name the active emulator"),
      // F4-05: the guard blocks new collection starts; it says nothing about a collector already running.
      guard: entry('Starting collection is blocked'),
      request_in_flight: entry('Sending'),
      already_on: entry('Harvesting is already on'),
      /** F-027: each prerequisite that is not in place says so. */
      request_unresolved: entry(
        'An earlier harvesting request has no answer yet',
        'Resend it or wait until a status read settles it; Turn on waits so it never adds a second request.',
      ),
      status_incomplete: entry(
        'Waiting for a complete status read',
        'Turn on needs a fresh status read whose process list names every owner completely.',
      ),
      not_connected: entry('The emulator is not confirmed connected'),
      taps_off: entry('Game input is off', 'Harvesting taps the emulator; allow game input first.'),
      taps_unknown: entry("The game input setting can't be read"),
    },
    /** GM-24, GM-25, F-030: this battle's gem toggles (overlay facts, restated as reported). */
    overlay: {
      lead: entry('This battle:'),
      applied: entry('applied'),
      pending: entry('pending'),
      liveChoice: entry('your choice for this battle wins'),
      unsupported: entry("the run can't take this setting"),
      ownTiming: entry('the battle keeps its own timing'),
      routine: (adGems: boolean | null, floatingGems: boolean | null): CopyText =>
        made(
          `ad gems ${adGems === null ? 'unchanged' : adGems ? 'on' : 'off'}, floating gems ${
            floatingGems === null ? 'unchanged' : floatingGems ? 'on' : 'off'
          }`,
        ),
    },
  },
} as const;
