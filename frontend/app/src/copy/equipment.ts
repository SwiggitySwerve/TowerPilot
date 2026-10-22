import { entry, made } from './entry.ts';

export const equipment = {
  space: made(' '),
  pageName: entry('Equipment'),
  intro: entry(
    'Saved equipment selections for battle entry. Saving changes configuration only; it does not equip or verify anything in the game.',
  ),
  target: entry('Emulator / account / profile'),
  unknown: entry('Not reported'),
  noTarget: entry('Select an emulator and profile to read its saved loadouts.'),
  scope: entry('Save scope: one named loadout in this account’s configuration.'),
  limit: entry(
    'Save checks the current emulator, account, profile and connection, then sends that target and the configuration revision for the server to check before writing.',
  ),
  empty: entry(
    'No saved loadouts. Create loadouts in the previous dashboard before editing them here.',
  ),
  reading: entry('Reading saved equipment…'),
  readError: entry(
    'Saved equipment could not be read for this target. Kept drafts are unchanged. Read saved result before saving.',
  ),
  stale: entry(
    'This read is more than 30 seconds old. Read saved result to check the target and revision before saving.',
  ),
  read: entry('Read saved result'),
  list: entry('Saved loadouts'),
  editor: entry('Selected loadout'),
  consumers: entry('Used by saved runs'),
  unused: entry('No saved run references this loadout.'),
  missingTarget: entry(
    'This loadout is missing from the latest saved configuration. Its draft stays here; saving is blocked.',
  ),
  placeholder: entry('Placeholder — equips nothing'),
  untouched: entry('All categories left untouched'),
  manual: entry('Manual legacy equipment'),
  global: entry('Global preset'),
  category: entry('Category presets'),
  mode: entry('Selection mode'),
  global_preset: entry('Global preset selection'),
  cards: entry('Cards'),
  module_preset: entry('Modules'),
  guardian_preset: entry('Guardians'),
  workshop_preset: entry('Workshop'),
  bot_preset: entry('Bots'),
  none: entry('Leave untouched'),
  chooseGlobal: entry('Choose a discovered global preset'),
  missing: entry(
    'A saved selection is missing from this profile’s discoveries. It stays selected; repair discovery in Recognition.',
  ),
  recognition: entry('Open Recognition'),
  noChoice: entry('Select at least one discovered preset. An empty body cannot be saved.'),
  manualWarning: entry(
    'Manual equipment is read-only here. At battle entry, hand-equipping can permanently rewrite the active game preset. Switching mode removes the legacy fields listed below.',
  ),
  help: entry('How equipment is used'),
  helpGlobal: entry(
    'A global preset selects the game’s global picker at battle entry. Its contents are not inspected or verified here.',
  ),
  helpNone: entry(
    'Leave untouched omits that category from the saved selection; battle entry leaves its current game selection alone. This does not select the game’s None option.',
  ),
  helpManual: entry(
    'Manual modules or guardians can rewrite whichever game preset is active. This page preserves legacy data read-only until you explicitly review a conversion.',
  ),
  compare: entry('Review before and after'),
  before: entry('Original saved body'),
  latest: entry('Latest saved body'),
  after: entry('Proposed saved body'),
  removed: entry('Fields removed by this selection'),
  reviewConversion: entry('I reviewed the removed manual fields'),
  conversionNeeded: entry('Review the removed manual fields before saving this conversion.'),
  revision: entry('Latest configuration revision'),
  base: entry('Draft’s starting revision'),
  save: entry('Save selection'),
  cancel: entry('Cancel edits'),
  cancelTitle: entry('Discard this loadout’s edits?'),
  cancelBody: entry(
    'This removes only this loadout’s unsaved edits. The original saved body stays intact.',
  ),
  keep: entry('Keep editing'),
  dirty: entry('Unsaved selection'),
  clean: entry('Saved selection'),
  blocked: entry(
    'Save is unavailable. Check selections, target, revision and any unresolved result; read saved result when needed.',
  ),
  sending: entry('Saving this selection once… New edits stay in the draft.'),
  checking: entry('Checking the current account and profile… Nothing has been sent.'),
  contextChanged: entry('Not saved: the account or profile changed'),
  contextUnconfirmed: entry(
    'Not saved: the current account or profile could not be checked. Your draft is kept.',
  ),
  currentContext: entry('Current context reported by the server'),
  saved: entry('Selection saved in configuration. No game equipment was applied or verified.'),
  unknownResult: entry(
    'The save outcome is unknown. Do not send it again. Read saved result for the original target and loadout.',
  ),
  refused: entry('The backend refused this save. Your draft is kept.'),
  conflict: entry(
    'The saved configuration changed. Read saved result and review before saving again.',
  ),
  readApplied: entry(
    'The saved read contains the submitted selection. Newer edits remain unsaved.',
  ),
  readUnchanged: entry(
    'The saved read still has the original body and revision. Your draft is kept.',
  ),
  result: entry('Result for this loadout and target'),
  reconcile: entry('Keep draft against this read revision'),
  reconcileHelp: entry(
    'Review the latest saved body and your draft. This keeps your choices against the revision just read; saving still requires a separate click.',
  ),
  warnings: entry('Backend warnings and validation'),
  earlierValidation: entry(
    'Profile validation below is from a read before this save. Read saved result to refresh it.',
  ),
};
