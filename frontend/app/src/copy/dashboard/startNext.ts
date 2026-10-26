import { entry, made } from '../entry.ts';

/** Catalogue entries of the Dashboard's startNext part (spec section 6.2). Owned by its region. */
export const startNext = {
  picker: entry('Run to start'),
  empty: entry('No runs available'),
  unnamedRun: entry('Unnamed run'),
  start: entry('Start playing'),
  collect: entry('Collect gems only'),
  prepare: entry('Prepare runs on the Recognition page'),
  learn: entry('Learn missing screens'),
  startReason: entry('Start playing:'),
  collectReason: entry('Collect gems only:'),
  space: made(' '),
  setting: entry('Setting:'),
  readiness: {
    readiness_unknown: entry('readiness unknown'),
    readiness_check_failed: entry("readiness couldn't be checked"),
    needs_setup: entry('Needs setup'),
    ready: entry('Ready'),
    not_ready: entry('Not ready'),
  },
  imagesMissing: (count: number) => made(`${String(count)} screen images missing`),
  reasons: {
    pick_run: entry('Pick a run'),
    sending: entry('Sending'),
    guard_unconfirmed: entry('not confirmed'),
    input_off: entry('Game input is off'),
    connection_blocked: entry('The emulator is not connected'),
    guard_blocks: entry('the launch guard blocks this action'),
    setup_battle_unresolved: entry(
      "setup's test battle wasn't confirmed back on Home - see Needs you",
    ),
    pick_single_run: entry('Pick a single run'),
    preview_unavailable: entry("Can't read this run's gem settings"),
    context_changed: entry('the account or emulator changed - check the selected run'),
    gem_routines_off: entry('Ad gems and Floating gems are both off in the saved settings'),
    ownership_unconfirmed: entry('emulator ownership is not confirmed'),
    automation_listed: entry('a collector or other automation is still recorded'),
  },
  transfer: {
    collector_stops_first: entry('Start stops the gem collector first; the battle keeps playing'),
    collector_recorded: entry(
      'A gem collector is still recorded; Start checks it before starting the run',
    ),
  },
} as const;
