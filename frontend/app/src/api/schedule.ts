import {
  contextFromConfig,
  contextKey,
  readStoredContext,
  sameContext,
  type PageContext,
} from './context.ts';
import { own } from '../core/read.ts';
import { readEndpoint } from './client.ts';
import { createIntentMachine, type IntentMachine } from './intents/machine.ts';
import { sendOnce } from './intents/send.ts';
import { createSequence } from './sequence.ts';
import {
  browserSessionStorage,
  keysWithPrefix,
  readJsonItem,
  writeJsonItem,
  type KeyValueStorage,
} from './storage.ts';
import { fetchTransport, type Transport } from './transport.ts';
import { bodyMembers, type Endpoint } from './wire.ts';
import {
  scheduleConfigAnswerSchema,
  schedulePatchAnswerSchema,
  schedulePlanAnswerSchema,
  scheduleProfileAnswerSchema,
} from '../contract/schedule.ts';
import { scheduleStatusAnswerSchema } from '../contract/dashboard.ts';

const sourceSchemas = [
  scheduleProfileAnswerSchema,
  schedulePatchAnswerSchema,
  schedulePlanAnswerSchema,
];
const source: Endpoint = {
  id: 'config',
  method: 'GET',
  strict: sourceSchemas,
  members: bodyMembers(sourceSchemas),
};
const config: Endpoint = {
  id: 'config',
  method: 'GET',
  strict: [scheduleConfigAnswerSchema],
  members: bodyMembers([scheduleConfigAnswerSchema]),
};
const status: Endpoint = {
  id: 'schedule',
  method: 'GET',
  strict: [schedulePlanAnswerSchema, scheduleStatusAnswerSchema],
  members: bodyMembers([schedulePlanAnswerSchema, scheduleStatusAnswerSchema]),
};

/** Keep this editor's unresolved intents separate from the Dashboard machine's records. */
function intentStorage(storage: KeyValueStorage | null): KeyValueStorage | null {
  if (storage === null) return null;
  const prefix = 'tp.schedule:';
  const keys = () => keysWithPrefix(storage, prefix);
  return {
    get length() {
      return keys().length;
    },
    key: (index) => keys()[index]?.slice(prefix.length) ?? null,
    getItem: (key) => storage.getItem(prefix + key),
    setItem: (key, value) => {
      storage.setItem(prefix + key, value);
    },
    removeItem: (key) => {
      storage.removeItem(prefix + key);
    },
  };
}

/** One explicit whole-plan save, using the shared duplicate-submission guard. */
export function sendScheduleSave(
  machine: IntentMachine,
  context: PageContext,
  revision: string,
  plan: unknown,
) {
  return sendOnce(machine, `schedule:${contextKey(context)}`, context, () =>
    machine.send({
      kind: 'schedule_save',
      target: `schedule:${contextKey(context)}`,
      endpoint: 'profilePatch',
      path: '/api/profile-patch',
      body: { name: context.profile, path: ['plan'], value: plan, expected_revision: revision },
      context,
      key: null,
      meta: { profileRevision: revision },
      supersedes: [],
    }),
  );
}

export function createScheduleApi(
  transport: Transport = fetchTransport,
  storage: KeyValueStorage | null = browserSessionStorage(),
  windowMs?: number,
) {
  const sequence = createSequence();
  const machine = createIntentMachine({
    transport,
    storage: intentStorage(storage),
    sequence,
    ...(windowMs === undefined ? {} : { windowMs }),
  });
  return {
    machine,
    sequence,
    targetKey: contextKey,
    configMatches: (body: unknown, context: PageContext) =>
      sameContext(contextFromConfig(body), context),
    reportMatches: (body: unknown, context: PageContext) =>
      sameContext(readStoredContext(own(body, 'context')), context),
    readConfig: (signal: AbortSignal) => readEndpoint(transport, config, '/api/config', signal),
    readProfile: (name: string, signal: AbortSignal) =>
      readEndpoint(transport, source, `/api/profile-src/${encodeURIComponent(name)}`, signal),
    readStatus: (context: PageContext, signal: AbortSignal) =>
      readEndpoint(
        transport,
        status,
        `/api/schedule/status?instance=${encodeURIComponent(context.instance)}`,
        signal,
      ),
    send: (context: PageContext, revision: string, plan: unknown) =>
      sendScheduleSave(machine, context, revision, plan),
    loadDraft: (key: string) => readJsonItem(storage, `tp.schedule.draft:${key}`),
    keepDraft: (key: string, draft: unknown) =>
      writeJsonItem(storage, `tp.schedule.draft:${key}`, draft),
  };
}
export type ScheduleApi = ReturnType<typeof createScheduleApi>;
