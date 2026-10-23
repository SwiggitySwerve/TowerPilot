import { entry, made } from './entry.ts';
export const shoppingLive = {
  title: entry('Queue for this battle'),
  edit: entry("Edit this battle's queue"),
  scope: entry(
    'Changes affect this battle only. Save records a request; the queue changes after the automation applies it.',
  ),
  save: entry('Save queue for this battle'),
  discard: entry('Discard queue edits'),
  dashboard: entry('Try once in Dashboard This battle'),
  check: entry('Check this battle'),
  overrides: entry(
    'Routine overrides keep precedence over this queue. The shopping switch and interval above remain unchanged.',
  ),
  on: entry('Automatic shopping is on'),
  off: entry('Automatic shopping is off'),
  interval: (seconds: number) => made(`Shopping interval: ${String(seconds)} seconds`),
  reasons: {
    unsupported: entry(
      'Live queue editing needs a version 2 queue and shopping plan controls advertised by this automation. Create or convert a saved queue for a later battle.',
    ),
    no_battle: entry('A tracked battle is required'),
    context_unknown: entry('Waiting for the emulator, account and profile to be read.'),
    battle_not_active: entry('An active tracked battle is required'),
    report_stale: entry('Read a fresh battle report before saving'),
    change_pending: entry('Waiting for the automation to apply the previous change'),
    revision_unknown: entry('The battle control revision is unknown'),
    save_in_flight: entry('A live change is sending'),
    save_unresolved: entry(
      'An earlier live change is Unknown. Check this battle or send that same request again.',
    ),
    refreshing: entry('Read this battle after the previous change'),
    invalid_value: entry('Review the queue fields before saving'),
    no_changes: entry('No queue changes to save'),
  },
};
