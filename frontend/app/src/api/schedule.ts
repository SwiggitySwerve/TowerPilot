import {
  contextFromConfig,
  contextKey,
  readStoredContext,
  sameContext,
  type PageContext,
} from './context.ts';
import { own } from '../core/read.ts';
import { readEndpoint } from './client.ts';
import { createClickTimeContextRead } from './clickContext.ts';
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
import { planDeleteSourceAnswerSchema } from '../contract/r12Families.ts';

const sourceSchemas = [
  scheduleProfileAnswerSchema,
  schedulePatchAnswerSchema,
  schedulePlanAnswerSchema,
  // F6-11 RL8: the profile reads around a removal of the whole plan (r12 candidate).
  planDeleteSourceAnswerSchema,
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

/**
 * F6-11 RL8: one explicit removal of the whole plan section ({op:"delete"} on ["plan"], r12
 * candidate plan_section_delete), through the same record kind as a plan save: a later read
 * without a plan settles it, as one holding a sent plan settles a save.
 */
export function sendScheduleRemove(machine: IntentMachine, context: PageContext, revision: string) {
  return sendOnce(machine, `schedule:${contextKey(context)}`, context, () =>
    machine.send({
      kind: 'schedule_save',
      target: `schedule:${contextKey(context)}`,
      endpoint: 'profilePatch',
      path: '/api/profile-patch',
      body: { name: context.profile, path: ['plan'], op: 'delete', expected_revision: revision },
      context,
      key: null,
      meta: { profileRevision: revision },
      supersedes: [],
    }),
  );
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
  // F6-11-P2-01: a profile patch names a profile, not the page context, so the server cannot
  // refuse a write after another client changed the emulator, account or profile: the page
  // fences each explicit click with a config read started after it (as Profiles, Collection).
  const readClickContext = createClickTimeContextRead(transport, config);
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
    /**
     * Whether a config read started now (never joined to an earlier read) still names exactly
     * `context`: `unconfirmed` when it has no usable answer.
     */
    checkContext: async (context: PageContext): Promise<'same' | 'changed' | 'unconfirmed'> => {
      const named = await readClickContext();
      return named === null ? 'unconfirmed' : sameContext(named, context) ? 'same' : 'changed';
    },
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
    remove: (context: PageContext, revision: string) =>
      sendScheduleRemove(machine, context, revision),
    loadDraft: (key: string) => readJsonItem(storage, `tp.schedule.draft:${key}`),
    keepDraft: (key: string, draft: unknown) =>
      writeJsonItem(storage, `tp.schedule.draft:${key}`, draft),
  };
}
export type ScheduleApi = ReturnType<typeof createScheduleApi>;
