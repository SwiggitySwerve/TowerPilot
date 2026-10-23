import { editingTarget } from './editingTarget.ts';
import { recognitionAdvanced } from './recognitionAdvanced.ts';
import { recognition } from './recognition.ts';
import { automation } from './dashboard/automation.ts';
import { recent } from './dashboard/recent.ts';
import { control } from './dashboard/control.ts';
import { needsYou } from './dashboard/needsYou.ts';
import { outcomes } from './dashboard/outcomes.ts';
import { shell } from './dashboard/shell.ts';
import { startNext } from './dashboard/startNext.ts';
import { thisBattle } from './dashboard/thisBattle.ts';
import { topBar } from './dashboard/topBar.ts';
import { entry, made } from './entry.ts';
import { runs } from './runs.ts';
import { runsAdd } from './runsAdd.ts';
import { runEntry } from './runEntry.ts';
import { history } from './history.ts';
import { runtime } from './runtime.ts';
import { shopping } from './shopping.ts';
import { shoppingLibrary } from './shoppingLibrary.ts';
import { shoppingLive } from './shoppingLive.ts';
import { shoppingSaved } from './shoppingSaved.ts';
import type { CopyEntry, CopyText } from './text.ts';

export { observeCopy } from './entry.ts';

/**
 * Every user-visible string in the app. Components read from here; lint
 * forbids string literals in JSX.
 */
export const copy = {
  app: {
    name: entry('Tower Pilot'),
    title: entry('Tower Pilot'),
    noScript: entry('Tower Pilot needs JavaScript enabled in this browser.'),
  },
  common: {
    why: entry('Why'),
  },
  routes: {
    dashboard: entry('Dashboard'),
    runs: entry('Runs'),
    notFound: entry(
      'Page not found',
      'This address does not match a page of the new app. The Dashboard link below opens the start page.',
    ),
    backToDashboard: entry('Open the Dashboard'),
  },
  /** Spec 3.1: the eight status words (also under dashboard.shell.states). */
  states: shell.states,
  runs,
  runsAdd,
  editingTarget,
  runEntry,
  shopping,
  shoppingLibrary,
  shoppingLive,
  shoppingSaved,
  history,
  runtime,
  recognition,
  recognitionAdvanced,
  dashboard: {
    shell,
    topBar,
    control,
    automation,
    outcomes,
    needsYou,
    thisBattle,
    startNext,
    recent,
    topbar: {
      account: entry('Account:'),
      noProfile: entry('No profile yet'),
      accountUnknown: entry('Account unknown', 'The account could not be read.'),
    },
    placeholder: entry(
      'Dashboard (rebuild in progress)',
      'The new Dashboard is being built step by step. Until it is finished, the current Dashboard stays the default page.',
    ),
    openCurrent: entry('Open the current Dashboard'),
  },
  errors: {
    regionFailed: entry(
      'This part of the page could not be drawn.',
      'The rest of the page still works. Reloading the page draws it again.',
    ),
  },
} as const;

export type Copy = typeof copy;

/** The browser tab title for a page: "<page> - Tower Pilot". Text, so it is CopyText too. */
export function documentTitle(page: CopyEntry): CopyText {
  return made(`${page.short} - ${copy.app.title.short}`);
}

/** How long something has taken, in whole seconds: "1 second", "12 seconds". */
export function elapsedSeconds(seconds: number): CopyText {
  const whole = Math.max(0, Math.round(seconds));
  return made(whole === 1 ? '1 second' : `${String(whole)} seconds`);
}
