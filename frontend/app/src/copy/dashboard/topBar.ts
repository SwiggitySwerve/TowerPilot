import { entry } from '../entry.ts';

/** Catalogue entries of the Dashboard's topBar part (spec section 6.2). Owned by its region. */
export const topBar = {
  accountDetails: entry('Account details'),
  emulator: entry('Emulator:'),
  emulatorUnknown: entry('Emulator name unknown'),
  instance: entry('Configured instance:'),
  details: entry('Details'),
  pages: entry('Pages'),
  reconnect: entry('Reconnect'),
  chooseEmulator: entry('Choose emulator'),
  reconnectReasons: {
    process_listed: entry('Reconnect is unavailable while an automation process is listed'),
    sending: entry('Reconnect is sending; wait for its reply'),
    process_list_unavailable: entry('Reconnect needs a readable process list'),
  },
  connection: {
    connected: entry('Connected'),
    connection_unconfirmed: entry('connection not confirmed'),
    adb_offline: entry('adb: emulator offline'),
    adb_unauthorized: entry('adb: not authorized'),
    adb_missing: entry('Not found by adb'),
    adb_unreachable: entry('Cannot connect to the adb server'),
    emulator_unconfigured: entry('No emulator chosen'),
  },
  notRead: entry('No successful status read yet'),
  /** The new app's own pages (Runs brief RUN-12), before the previous pages. */
  appPages: [
    { id: 'dashboard', label: entry('Dashboard') },
    { id: 'runs', label: entry('Runs') },
    { id: 'history', label: entry('Run history') },
    { id: 'schedule', label: entry('Schedule') },
    { id: 'equipment', label: entry('Equipment') },
    { id: 'profiles', label: entry('Profiles') },
    { id: 'abilities', label: entry('Abilities') },
    { id: 'collection', label: entry('Collection') },
    { id: 'emulators', label: entry('Emulators') },
    { id: 'runtime', label: entry('Runtime') },
    { id: 'recognition', label: entry('Recognition') },
  ],
  legacyPages: [
    {
      hash: 'overview',
      label: entry('Previous Dashboard', 'Unresolved requests stay on this page'),
    },
    {
      hash: 'runs',
      label: entry(
        'Previous Runs page',
        'The shopping queue and the entry and equipment settings are still edited there',
      ),
    },
  ],
} as const;
