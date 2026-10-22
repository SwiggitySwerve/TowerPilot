import { contextFromConfig, contextKey, sameContext, type PageContext } from './context.ts';
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

const endpoint = (strict: Endpoint['strict'], method: 'GET' | 'POST' = 'GET'): Endpoint => ({
  id: method === 'GET' ? 'config' : 'runControlsSave',
  method,
  strict,
  members: bodyMembers(strict),
});
const config = endpoint([schemas.abilitiesConfigAnswerSchema]);
const profile = endpoint([
  schemas.abilitiesSourceAnswerSchema,
  schemas.abilitiesProfileAnswerSchema,
  schemas.abilitiesSampleSourceAnswerSchema,
]);
const vocab = endpoint([schemas.abilitiesVocabAnswerSchema]);
const settings = endpoint([schemas.abilitiesSettingsAnswerSchema]);
const patch = endpoint(
  [
    schemas.abilitiesPatchAnswerSchema,
    schemas.abilitiesSettingsSaveAnswerSchema,
    schemas.abilitiesSamplePatchAnswerSchema,
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
    configMatches: (value: unknown, context: PageContext) =>
      sameContext(contextFromConfig(value), context),
    config: (signal: AbortSignal) => readEndpoint(transport, config, '/api/config', signal),
    profile: (name: string, signal: AbortSignal) =>
      readEndpoint(transport, profile, `/api/profile-src/${encodeURIComponent(name)}`, signal),
    vocab: (signal: AbortSignal) => readEndpoint(transport, vocab, '/api/vocab', signal),
    settings: (signal: AbortSignal) => readEndpoint(transport, settings, '/api/settings', signal),
    send: (context: PageContext, path: ApiPath, body: Readonly<Record<string, unknown>>) =>
      sendOnce(machine, `abilities:${contextKey(context)}`, context, () =>
        machine.send({
          kind: 'run_save',
          target: `abilities:${contextKey(context)}`,
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
