import {
  checkEntry,
  entryDraftSnapshot,
  entryRaw,
  runEntryFields,
  type EntryReason,
} from '../../core/runEntry.ts';
import { id, own, ownPath } from '../../core/read.ts';
import { fromServer } from '../../copy/server.ts';
import { boundIntents, contextScopeKey } from '../intents.ts';
import { answeredBody } from '../reads.ts';
import { settledByRead } from '../fences.ts';
import type { DashboardState } from '../types.ts';
import type { ProfilePatchCommand } from './collection.ts';
import { saveOutcome, settingsSavePending } from './settingsModule.ts';
import { runsPageRun } from './readPlan.ts';

/** RL3's saved entry fields. All parsing and legality belongs to core/runEntry. */
export function selectRunEntry(state: DashboardState) {
  const context = state.context;
  const run = runsPageRun(state);
  const sourceRead = state.reads.profileSource.latest;
  const source = answeredBody(state, 'profileSource');
  const revision = id(own(source, 'revision')) ?? null;
  const readable =
    sourceRead?.outcome.kind === 'answered' &&
    sourceRead.outcome.status === 200 &&
    own(source, 'name') === context?.profile &&
    revision !== null;
  const vocab = answeredBody(state, 'vocab');
  const records = boundIntents(state).filter((record) => record.kind === 'profile_patch');
  const unresolved = records.filter(
    (record) =>
      record.phase === 'unconfirmed' &&
      record.accepted !== true &&
      settledByRead(state, record) === null,
  );
  const pending = settingsSavePending(state, ['profileSource']);
  const fields =
    run === null || context === null || own(source, 'name') !== context.profile
      ? []
      : runEntryFields(source, run, answeredBody(state, 'config'), vocab).map((field) => {
          const scope = `runs:entry:${run}:${field.key}:${contextScopeKey(context)}`;
          const draft = state.runDrafts[scope] ?? {};
          const marker = entryDraftSnapshot(draft['base_revision']);
          const raw = draft['value'] ?? marker?.raw ?? entryRaw(field);
          const remove =
            draft['remove'] === undefined ? (marker?.remove ?? false) : draft['remove'] === true;
          const base = marker?.revision ?? revision;
          const checked = checkEntry(field, raw, remove);
          const outcome = saveOutcome(state, scope);
          const record = records.findLast((item) => item.target === scope);
          const stale =
            record?.phase === 'refused' &&
            own(record.answer?.body, 'code') === 'revision_conflict' &&
            draft['continued_after'] !== record.id;
          const reason: EntryReason | 'unavailable' | 'unknown' | 'pending' | 'revision' | null =
            !readable ||
            !state.contextConfirmed ||
            ownPath(vocab, 'vocab', 'blueprint_fields') === undefined
              ? 'unavailable'
              : unresolved.length > 0
                ? 'unknown'
                : pending
                  ? 'pending'
                  : stale || (base !== revision && Object.keys(draft).length > 0)
                    ? 'revision'
                    : checked.kind === 'invalid'
                      ? checked.reason
                      : null;
          const command: ProfilePatchCommand | null =
            reason === null && base !== null && checked.kind === 'valid'
              ? {
                  epoch: state.epoch,
                  context,
                  target: scope,
                  revision: base,
                  path: ['blueprints', run, ...field.key.split('.')],
                  remove: checked.remove,
                  value: checked.value,
                  draft: { scope, values: draft },
                }
              : null;
          // A newer read is necessary even for explicit acceptance. An unchanged read leaves the
          // journal Unknown; accepting it merely opens the gate for a new, explicit save.
          const after = Math.max(
            0,
            ...unresolved.map((item) => item.answerSeq ?? item.lostSeq ?? item.sentSeq),
            stale ? (record.answerSeq ?? record.sentSeq) : 0,
          );
          const canContinue =
            readable &&
            sourceRead.startedSeq > after &&
            (reason === 'unknown' || reason === 'revision');
          const continuation = canContinue
            ? {
                revision,
                ids: unresolved.map((item) => item.id),
                after: record?.id ?? '',
              }
            : null;
          const reference = id(field.saved);
          const policyEditor:
            | { readonly kind: 'gather'; readonly id: string }
            | { readonly kind: 'abilities' }
            | null =
            reference === undefined
              ? null
              : field.key === 'policies.gather'
                ? { kind: 'gather', id: reference }
                : field.key === 'policies.uw' || field.key === 'policies.rescue'
                  ? { kind: 'abilities' }
                  : null;
          return {
            key: field.key,
            type: field.type,
            scope,
            raw,
            remove,
            revision,
            baseRevision: base,
            dirty: Object.keys(draft).length > 0,
            reason,
            command,
            continuation,
            policyEditor,
            choices: field.choices.map((choice) => ({
              value: choice.value,
              label: fromServer('name', choice.label),
            })),
            unlisted:
              field.type === 'select' &&
              typeof raw === 'string' &&
              raw !== '' &&
              !field.choices.some((choice) => choice.value === raw)
                ? fromServer('name', raw)
                : null,
            none: field.removable && field.type === 'select',
            outcome: outcome === null ? null : { ...outcome, acceptOffered: false },
            profiles:
              record?.phase === 'refused' &&
              record.answer?.status === 409 &&
              own(record.answer.body, 'code') !== 'revision_conflict',
          };
        });
  return {
    fields,
    readable,
    run,
    notSent: state.notices.some(
      (notice) =>
        notice.kind === 'command_not_sent' &&
        ['context_changed', 'context_unconfirmed', 'collection_write_in_flight'].includes(
          notice.reason,
        ),
    ),
  };
}
