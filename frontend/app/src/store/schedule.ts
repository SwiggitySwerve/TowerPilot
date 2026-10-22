import type { PageContext } from '../api/context.ts';
import type { IntentRecord } from '../api/intents/types.ts';
import type { ScheduleApi } from '../api/schedule.ts';
import { own, text } from '../core/read.ts';
import { createStore, viewEqual, type Store } from './store.ts';
import {
  planOf,
  profileRevision,
  restoreScheduleDraft,
  scheduleDraft,
  schedulePlan,
  type BlockField,
  type ScheduleDraft,
} from './scheduleDraft.ts';

export interface ScheduleEntry {
  readonly source: unknown;
  readonly observed: unknown;
  readonly observedAtMs: number | null;
  readonly observationFailed: boolean;
  readonly draft: ScheduleDraft | null;
  readonly baseRevision: string | null;
  /** Shared request sequence of the latest authoritative save answer for this target. */
  readonly acceptedSaveSeq: number;
  readonly day: string;
  readonly dirty: boolean;
  readonly version: number;
  readonly busy: boolean;
  readonly readError: boolean;
  readonly intent: IntentRecord | null;
  readonly reconcile: boolean;
  readonly checked: boolean;
  readonly focus: string | null;
  readonly resolvedIntent: string | null;
}
export interface ScheduleState {
  readonly context: PageContext | null;
  readonly epoch: number;
  readonly key: string | null;
  readonly entries: Readonly<Record<string, ScheduleEntry>>;
}
export interface ScheduleStore extends Store<ScheduleState> {
  readonly setTarget: (context: PageContext | null, epoch: number) => void;
  readonly refresh: () => Promise<void>;
  readonly selectDay: (day: string) => void;
  readonly edit: (key: string, field: BlockField, value: string) => void;
  readonly mapWeek: (slot: string, value: string) => void;
  readonly add: () => string | null;
  readonly move: (key: string, direction: -1 | 1) => number | null;
  readonly remove: (key: string) => string | null;
  readonly save: () => void;
  readonly discard: () => void;
  readonly reconcile: () => void;
  readonly rememberFocus: (focus: string) => void;
  readonly dispose: () => void;
}
const empty = (): ScheduleEntry => ({
  source: undefined,
  observed: undefined,
  observedAtMs: null,
  observationFailed: false,
  draft: null,
  baseRevision: null,
  acceptedSaveSeq: 0,
  day: '',
  dirty: false,
  version: 0,
  busy: false,
  readError: false,
  intent: null,
  reconcile: false,
  checked: false,
  focus: null,
  resolvedIntent: null,
});
export const currentSchedule = (state: ScheduleState): ScheduleEntry | null =>
  state.key === null ? null : (state.entries[state.key] ?? null);

/** Owns target-bound drafts, read fences and revision reconciliation; never schedules a run. */
export function createScheduleStore(api: ScheduleApi, now: () => number = Date.now): ScheduleStore {
  const store = createStore<ScheduleState>({ context: null, epoch: 0, key: null, entries: {} });
  let controller: AbortController | null = null;
  let counter = 0;
  const submitted = new Map<string, { readonly version: number; readonly plan: unknown }>();
  const change = (key: string, transform: (entry: ScheduleEntry) => ScheduleEntry) => {
    store.update((s) => ({
      ...s,
      entries: { ...s.entries, [key]: transform(s.entries[key] ?? empty()) },
    }));
    const entry = store.getSnapshot().entries[key];
    if (entry !== undefined)
      api.keepDraft(key, {
        draft: entry.dirty && entry.draft !== null ? entry.draft : undefined,
        revision: entry.baseRevision,
        day: entry.day,
        focus: entry.focus,
      });
  };
  const activeChange = (transform: (entry: ScheduleEntry) => ScheduleEntry) => {
    const key = store.getSnapshot().key;
    if (key !== null) change(key, transform);
  };
  const editDraft = (transform: (draft: ScheduleDraft, day: string) => ScheduleDraft) => {
    activeChange((entry) =>
      entry.draft === null
        ? entry
        : {
            ...entry,
            draft: transform(entry.draft, entry.day),
            dirty: true,
            version: entry.version + 1,
          },
    );
  };
  const sync = () => {
    for (const intent of api.machine.snapshot()) {
      if (
        intent.kind !== 'schedule_save' ||
        intent.context === null ||
        intent.supersededBySeq !== null
      )
        continue;
      const key = api.targetKey(intent.context);
      const entry = store.getSnapshot().entries[key];
      if (entry === undefined || entry.intent === intent) continue;
      const sent = submitted.get(intent.id);
      const accepted = intent.phase === 'confirmed' && own(intent.answer?.body, 'ok') === true;
      const exact =
        sent !== undefined &&
        sent.version === entry.version &&
        viewEqual(planOf(intent.answer?.body), sent.plan);
      change(key, (e) => ({
        ...e,
        intent,
        ...(accepted
          ? {
              source: intent.answer?.body,
              baseRevision: profileRevision(intent.answer?.body),
              acceptedSaveSeq: Math.max(e.acceptedSaveSeq, intent.answerSeq ?? intent.sentSeq),
            }
          : {}),
        ...(accepted && exact ? { dirty: false } : {}),
        reconcile:
          e.reconcile ||
          own(intent.answer?.body, 'code') === 'revision_conflict' ||
          (accepted && sent !== undefined && !viewEqual(planOf(intent.answer?.body), sent.plan)),
        checked:
          own(intent.answer?.body, 'code') === 'revision_conflict' || accepted ? false : e.checked,
      }));
    }
  };
  const unsubscribe = api.machine.subscribe(sync);

  const refresh = async () => {
    const state = store.getSnapshot();
    const { context, key, epoch } = state;
    if (context === null || key === null || controller !== null) return;
    const request = new AbortController();
    controller = request;
    const started = api.sequence.next();
    change(key, (e) => ({ ...e, busy: true, readError: false }));
    const config = await api.readConfig(request.signal);
    const body = config.kind === 'answered' ? config.answer.body : undefined;
    const correct = api.configMatches(body, context);
    const [profile, status] = correct
      ? await Promise.all([
          context.profile === null
            ? Promise.resolve(null)
            : api.readProfile(context.profile, request.signal),
          api.readStatus(context, request.signal),
        ])
      : [null, null];
    if (
      controller !== request ||
      store.getSnapshot().key !== key ||
      store.getSnapshot().epoch !== epoch
    )
      return;
    controller = null;
    // Revisions are opaque hashes. Order evidence with the same sequence as writes,
    // so an older read cannot undo an accepted source or its validation metadata.
    const sourceObsolete = started <= (store.getSnapshot().entries[key]?.acceptedSaveSeq ?? 0);
    const source =
      !sourceObsolete &&
      profile?.kind === 'answered' &&
      own(profile.answer.body, 'name') === context.profile &&
      own(profile.answer.body, 'ok') === true
        ? profile.answer.body
        : undefined;
    const observation = status?.answer?.body;
    const statusMatches =
      (status?.kind === 'failed' &&
        status.answer?.status === 400 &&
        own(observation, 'error') === 'Unknown emulator') ||
      api.reportMatches(observation, context);
    change(key, (e) => {
      const draft =
        e.dirty || source === undefined ? e.draft : scheduleDraft(own(source, 'profile'));
      return {
        ...e,
        busy: false,
        readError:
          !correct || (!sourceObsolete && context.profile !== null && source === undefined),
        ...(source === undefined
          ? {}
          : {
              source,
              draft,
              baseRevision: e.dirty ? e.baseRevision : profileRevision(source),
              day: e.day || Object.keys(draft?.days ?? {})[0] || '',
              checked: true,
            }),
        observed: statusMatches ? observation : e.observed,
        observedAtMs: statusMatches ? now() : e.observedAtMs,
        observationFailed: !statusMatches,
      };
    });
    const e = store.getSnapshot().entries[key];
    const intent = e?.intent;
    if (
      source !== undefined &&
      intent?.phase === 'unconfirmed' &&
      started > (intent.answerSeq ?? intent.sentSeq)
    ) {
      const value: unknown = JSON.parse(intent.request.body);
      const revision = profileRevision(source);
      const applied =
        revision !== intent.meta.profileRevision && viewEqual(planOf(source), own(value, 'value'));
      // Shared rule (Collection review F6C-R1-02): only a read holding the sent plan settles
      // the save; an unchanged revision cannot prove it failed (it may still commit), so the
      // save stays unknown until the person reconciles explicitly.
      if (applied) {
        api.machine.settleByRead(intent.id, 'applied');
        change(key, (current) => ({
          ...current,
          baseRevision: revision,
          dirty:
            submitted.get(intent.id)?.version !== current.version ||
            !viewEqual(
              current.draft === null ? undefined : schedulePlan(current.draft),
              own(value, 'value'),
            ),
        }));
      } else change(key, (current) => ({ ...current, reconcile: true }));
    }
  };

  return {
    ...store,
    setTarget: (context, epoch) => {
      const key = context === null ? null : api.targetKey(context);
      if (key === store.getSnapshot().key && epoch === store.getSnapshot().epoch) return;
      controller?.abort();
      controller = null;
      const oldKey = store.getSnapshot().key;
      if (oldKey !== null) change(oldKey, (e) => ({ ...e, busy: false }));
      store.update((s) => ({ ...s, context, epoch, key }));
      api.machine.setContext(context, epoch);
      if (key === null) return;
      if (store.getSnapshot().entries[key] === undefined) {
        const stored = api.loadDraft(key);
        const draft = restoreScheduleDraft(own(stored, 'draft'));
        change(key, () => ({
          ...empty(),
          draft,
          dirty: draft !== null,
          baseRevision: text(own(stored, 'revision')) ?? null,
          day: text(own(stored, 'day')) ?? '',
          focus: text(own(stored, 'focus')) ?? null,
        }));
      }
      sync();
      void refresh();
    },
    refresh,
    selectDay: (day) => {
      activeChange((e) => (e.draft?.days[day] === undefined ? e : { ...e, day }));
    },
    edit: (key, field, value) => {
      editDraft((draft, day) => ({
        ...draft,
        days: {
          ...draft.days,
          [day]: (draft.days[day] ?? []).map((block) =>
            block.key === key ? { ...block, [field]: value } : block,
          ),
        },
      }));
    },
    mapWeek: (slot, value) => {
      editDraft((draft) => ({ ...draft, week: { ...draft.week, [slot]: value } }));
    },
    add: () => {
      const e = currentSchedule(store.getSnapshot());
      const seed =
        e?.draft?.days[e.day]?.[0] ??
        scheduleDraft(own(e?.source, 'profile'))?.days[e?.day ?? '']?.[0];
      if (seed === undefined) return null;
      const key = `added:${++counter}:${now()}`;
      editDraft((draft, day) => ({
        ...draft,
        days: { ...draft.days, [day]: [...(draft.days[day] ?? []), { ...seed, key }] },
      }));
      return key;
    },
    move: (key, direction) => {
      let position: number | null = null;
      editDraft((draft, day) => {
        const blocks = [...(draft.days[day] ?? [])];
        const from = blocks.findIndex((b) => b.key === key);
        const to = from + direction;
        const moving = blocks[from];
        if (moving === undefined || to < 0 || to >= blocks.length) return draft;
        blocks.splice(from, 1);
        blocks.splice(to, 0, moving);
        position = to + 1;
        return { ...draft, days: { ...draft.days, [day]: blocks } };
      });
      return position;
    },
    remove: (key) => {
      const e = currentSchedule(store.getSnapshot());
      const blocks = e?.draft?.days[e.day] ?? [];
      const index = blocks.findIndex((b) => b.key === key);
      const remaining = blocks.filter((b) => b.key !== key);
      editDraft((draft, day) => ({ ...draft, days: { ...draft.days, [day]: remaining } }));
      return remaining[Math.min(index, remaining.length - 1)]?.key ?? null;
    },
    save: () => {
      const s = store.getSnapshot();
      const e = currentSchedule(s);
      if (
        s.context?.profile === null ||
        s.context === null ||
        e?.draft === null ||
        e === null ||
        !e.dirty ||
        e.busy ||
        e.readError ||
        e.baseRevision === null ||
        e.reconcile ||
        e.intent?.phase === 'sending' ||
        (e.intent?.phase === 'unconfirmed' &&
          e.intent.readSettlement === null &&
          e.resolvedIntent !== e.intent.id)
      )
        return;
      const plan = schedulePlan(e.draft);
      const result = api.send(s.context, e.baseRevision, plan);
      if (result.kind === 'sent') submitted.set(result.record.id, { version: e.version, plan });
    },
    discard: () => {
      activeChange((e) => ({
        ...e,
        draft: scheduleDraft(own(e.source, 'profile')),
        baseRevision: profileRevision(e.source),
        dirty: false,
        version: e.version + 1,
      }));
    },
    reconcile: () => {
      activeChange((e) =>
        !e.checked || e.busy || e.intent?.phase === 'sending'
          ? e
          : {
              ...e,
              reconcile: false,
              baseRevision: profileRevision(e.source),
              resolvedIntent: e.intent?.id ?? null,
            },
      );
    },
    rememberFocus: (focus) => {
      activeChange((e) => ({ ...e, focus }));
    },
    dispose: () => {
      controller?.abort();
      controller = null;
      unsubscribe();
      api.machine.dispose();
    },
  };
}
