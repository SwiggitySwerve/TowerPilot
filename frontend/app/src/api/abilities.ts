import {
  contextFromConfig,
  contextKey,
  expectedContext,
  sameContext,
  type PageContext,
} from './context.ts';
import { createClickTimeTargetCheck } from './clickContext.ts';
import { GET_TIMEOUT_MS } from './poller.ts';
import { editTargetScope } from '../core/editingTarget.ts';
import { readEndpoint } from './client.ts';
import { createIntentMachine } from './intents/machine.ts';
import { sendOnce } from './intents/send.ts';
import { createSequence } from './sequence.ts';
import { restoreDrafts, saveDrafts } from './drafts.ts';
import {
  browserSessionStorage,
  readJsonItem,
  writeJsonItem,
  type KeyValueStorage,
} from './storage.ts';
import { fetchTransport, type ApiPath, type Transport } from './transport.ts';
import { bodyMembers, ENDPOINTS, type Endpoint } from './wire.ts';
import * as schemas from '../contract/abilities.ts';
import {
  profileTargetConfigAnswerSchema,
  profileTargetSourceAnswerSchema,
  profileTargetPatchAnswerSchema,
} from '../contract/profileTarget.ts';

const endpoint = (strict: Endpoint['strict'], method: 'GET' | 'POST' = 'GET'): Endpoint => ({
  id: method === 'GET' ? 'config' : 'runControlsSave',
  method,
  strict,
  members: bodyMembers(strict),
});
const config = endpoint([schemas.abilitiesConfigAnswerSchema, profileTargetConfigAnswerSchema]);
const profile = endpoint([
  schemas.abilitiesSourceAnswerSchema,
  schemas.abilitiesProfileAnswerSchema,
  schemas.abilitiesSampleSourceAnswerSchema,
  profileTargetSourceAnswerSchema,
]);
const vocab = endpoint([schemas.abilitiesVocabAnswerSchema]);
const settings = endpoint([schemas.abilitiesSettingsAnswerSchema]);
const patch = endpoint(
  [
    schemas.abilitiesPatchAnswerSchema,
    schemas.abilitiesSettingsSaveAnswerSchema,
    schemas.abilitiesSamplePatchAnswerSchema,
    profileTargetPatchAnswerSchema,
  ],
  'POST',
);

/** One non-resendable journal for both revision domains. The store durably keeps the
 * frozen submission with its raw draft; a reload restores it as unknown, never sends it.
 * run_save is the existing saved-configuration journal kind. Its Runs classifier cannot
 * confirm these answers; the Abilities owner verifies the named value and revision. */
export function createAbilitiesApi(
  transport: Transport = fetchTransport,
  storage: KeyValueStorage | null = browserSessionStorage(),
  windowMs?: number,
) {
  const machine = createIntentMachine({
    transport,
    storage: null,
    sequence: createSequence(),
    endpoints: { ...ENDPOINTS, runControlsSave: patch },
    ...(windowMs === undefined ? {} : { windowMs }),
  });
  return {
    machine,
    targetKey: contextKey,
    editTargetScope,
    expectedContext,
    checkTarget: createClickTimeTargetCheck(transport, {
      config,
      profileFiles: ENDPOINTS.profileFiles,
    }),
    configMatches: (value: unknown, context: PageContext) =>
      sameContext(contextFromConfig(value), context),
    config: (signal: AbortSignal) => readEndpoint(transport, config, '/api/config', signal),
    profile: (name: string, signal: AbortSignal) =>
      readEndpoint(transport, profile, `/api/profile-src/${encodeURIComponent(name)}`, signal),
    vocab: (signal: AbortSignal) => readEndpoint(transport, vocab, '/api/vocab', signal),
    settings: (signal: AbortSignal) =>
      readEndpoint(
        transport,
        settings,
        '/api/settings',
        AbortSignal.any([signal, AbortSignal.timeout(GET_TIMEOUT_MS)]),
      ),
    send: (
      context: PageContext,
      path: ApiPath,
      body: Readonly<Record<string, unknown>>,
      scope = contextKey(context),
    ) =>
      sendOnce(machine, `abilities:${scope}`, context, () =>
        machine.send({
          kind: 'run_save',
          target: `abilities:${scope}`,
          endpoint: 'runControlsSave',
          path,
          body,
          context,
          key: null,
          meta: {},
          supersedes: [],
        }),
      ),
    load: (key: string) => readJsonItem(storage, `tp.abilities:${key}`),
    keep: (key: string, value: unknown) => writeJsonItem(storage, `tp.abilities:${key}`, value),
    loadNewId: (key: string, family: string): string => {
      const value = restoreDrafts(storage)[`abilities:new_${family}:${key}`]?.['id'];
      return typeof value === 'string' ? value : '';
    },
    keepNewId: (key: string, family: string, value: string) => {
      saveDrafts(storage, {
        ...restoreDrafts(storage),
        [`abilities:new_${family}:${key}`]: value === '' ? {} : { id: value },
      });
    },
  };
}
export type AbilitiesApi = ReturnType<typeof createAbilitiesApi>;
