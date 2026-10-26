import { entry } from './entry.ts';

export const emulatorSettings = {
  context: entry('Selected emulator — page context'),
  configured: entry('Configured emulator / Saved defaults'),
  defaults: entry('Saved defaults'),
  nextStart: entry(
    'Start automatically at the next tray start.',
    'Saving changes the file only. It does nothing now: it never starts, stops or reconnects an emulator. An explicit tray CLI autostart list takes precedence over this saved choice.',
  ),
  switchIntro: entry(
    'Choose the emulator every page shows',
    'Review and confirm this context change separately from saved defaults. Drafts stay with their original targets. This does not start or stop anything.',
  ),
  confirmBefore: entry('Use '),
  confirmAfter: entry(' as the page context?'),
  confirmBody: entry(
    'Every page will show that emulator and its account/profile. Drafts stay with their original targets. This does not start or stop anything.',
  ),
  confirm: entry('Use emulator'),
  submittedFrom: entry('Context request submitted from emulator:'),
  cancel: entry('Cancel'),
  check: entry('Read saved settings again'),
  notRead: entry('Saved emulator settings have not been read yet.'),
  noModule: entry('The server did not offer this settings module.'),
  stale: entry(
    'The last settings read failed. Your edits are kept; read the settings again before saving.',
  ),
  unavailable: entry('Saved emulator settings are unavailable. Read them again before saving.'),
};
