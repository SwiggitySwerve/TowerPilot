import { entries, finite, id, list, own, ownOr, ownPath, record, text } from './read.ts';

/**
 * A2-7 timed actions (brief backend/logs/reviews/ui-pages/a2-7-actions-brief.md; rules in
 * actions.rules.md): the one owner of what the app knows about a timed action. It reads the
 * projection `battle.runtime.actions` into plain views, holds the compatibility routine list for
 * a driver that publishes no projection, the shopping action predicates, the editor field order,
 * the live bounds source (R2) and the action-name and field-label lookups. It holds no copy: callers
 * pass their word tables.
 */

/** An action's routine key: the `<key>` of a control path `routines.<key>.<field>` and of a Run now token. */
export type ActionKey = string;

/**
 * S5: the routines a driver that never built the projection publishes (pre-A2 code can publish
 * only these), in the Dashboard's row order. Kept until every driver publishes `runtime.actions`
 * (root decision Q1, end of roadmap item 7); deleted with AC12.
 */
export const COMPAT_ROUTINES: readonly ActionKey[] = ['ad_gems', 'floating_gems', 'shopping'];

/** S5: the field order of the compatibility routines' controls (the editor's columns). */
export const COMPAT_FIELDS: readonly string[] = [
  'enabled',
  'interval_sec',
  'window_sec',
  'tap_interval_sec',
];

/** S5: the result line of a compatibility gem routine whose last outcome is confirmed. */
export function compatClaimLine(
  routine: ActionKey,
): 'claim_confirmed' | 'floating_claim_confirmed' {
  return routine === 'ad_gems' ? 'claim_confirmed' : 'floating_claim_confirmed';
}

/** S2: a shopping variant token (`shopping:<section>[:<upgrade>]`, F6-12 Try once). */
export function isShoppingVariant(token: string): boolean {
  return token.startsWith('shopping:');
}

/** S2: the shopping action itself or one of its variants (the shopping queue's own rules apply). */
export function isShoppingAction(token: string): boolean {
  return token === 'shopping' || isShoppingVariant(token);
}

/**
 * The display entry of an action code from a code-keyed name table, else `other`. Kept apart
 * from `fieldLabel` (both read own keys through `ownOr`) because C1 and C2 move action names,
 * and then field labels, to the projection's labels one at a time.
 */
export function actionName<T>(names: Readonly<Record<string, T>>, action: string, other: T): T {
  return ownOr(names, action, other);
}

/** The display entry of a field code from a code-keyed label table, else `other`. */
export function fieldLabel<T>(labels: Readonly<Record<string, T>>, field: string, other: T): T {
  return ownOr(labels, field, other);
}

/** One field of an item's descriptor, as sent (server text stays raw for the selectors). */
export interface ActionFieldView {
  readonly path: string;
  /** `bool` or `number` as sent; null when the type is not a string. */
  readonly type: string | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly unit: string | null;
  readonly label: unknown;
  readonly live: boolean;
  readonly saved: boolean;
  readonly nullable: boolean;
}

/** One item of `runtime.actions.items`. */
export interface ActionItemView {
  readonly id: string;
  readonly instance: string;
  /**
   * The routine key of its control paths and Run now token: the published `key`, else `id`
   * when the item is its action's only instance (`instance === id`, brief gap G2), else null
   * (its controls cannot be addressed).
   */
  readonly key: ActionKey | null;
  readonly label: unknown;
  readonly fields: readonly ActionFieldView[];
}

/** The projection envelope `battle.runtime.actions`. */
export interface ActionsView {
  readonly schemaVersion: number | null;
  readonly observedAt: number | null;
  readonly controlRevision: number | null;
  readonly context: unknown;
  readonly items: readonly ActionItemView[];
}

function fieldView(raw: unknown): ActionFieldView | null {
  const path = id(own(raw, 'path'));
  if (path === undefined) return null;
  return {
    path,
    type: text(own(raw, 'type')) ?? null,
    min: finite(own(raw, 'min')) ?? null,
    max: finite(own(raw, 'max')) ?? null,
    unit: text(own(raw, 'unit')) ?? null,
    label: own(raw, 'label'),
    live: own(raw, 'live') === true,
    saved: own(raw, 'saved') === true,
    nullable: own(raw, 'nullable') === true,
  };
}

function itemView(raw: unknown): ActionItemView | null {
  const itemId = id(own(raw, 'id'));
  const instance = id(own(raw, 'instance'));
  if (itemId === undefined || instance === undefined) return null;
  const published = id(own(raw, 'key'));
  return {
    id: itemId,
    instance,
    key: published ?? (instance === itemId ? itemId : null),
    label: own(raw, 'label'),
    fields: (list(ownPath(raw, 'descriptor', 'fields')) ?? []).flatMap((field) => {
      const view = fieldView(field);
      return view === null ? [] : [view];
    }),
  };
}

/**
 * The projection of a battle (`battle.runtime.actions`), or null when the battle publishes none
 * (a driver that never built it: the S5 compatibility rows apply). Items without a readable id
 * and instance are left out.
 */
export function actionsView(battle: unknown): ActionsView | null {
  const raw = ownPath(battle, 'runtime', 'actions');
  if (record(raw) === undefined) return null;
  return {
    schemaVersion: finite(own(raw, 'schema_version')) ?? null,
    observedAt: finite(own(raw, 'observed_at')) ?? null,
    controlRevision: finite(own(raw, 'control_revision')) ?? null,
    context: own(raw, 'context'),
    items: (list(own(raw, 'items')) ?? []).flatMap((item) => {
      const view = itemView(item);
      return view === null ? [] : [view];
    }),
  };
}

/** The item whose controls live under `routines.<key>`, if the projection holds one. */
export function itemOfKey(view: ActionsView | null, key: ActionKey): ActionItemView | undefined {
  return view?.items.find((item) => item.key === key);
}

/**
 * The order of a routine's live fields: its item's live descriptor fields, else the
 * compatibility order (a routine without an item, or a battle without a projection).
 */
export function liveFieldOrder(view: ActionsView | null, key: ActionKey): readonly string[] {
  const item = itemOfKey(view, key);
  return item === undefined
    ? COMPAT_FIELDS
    : item.fields.filter((field) => field.live).map((field) => field.path);
}

/**
 * `fields` in `order`: the fields `order` names first, in its order, then every other field in
 * the order it came (never dropped).
 */
export function orderedFields<F extends { readonly field: string }>(
  fields: readonly F[],
  order: readonly string[],
): readonly F[] {
  const named = new Set(order);
  return [
    ...order.flatMap((name) => fields.filter((field) => field.field === name)),
    ...fields.filter((field) => !named.has(field.field)),
  ];
}

/** R2: the projection gives some live number field its bounds (the live editor's bounds are known). */
export function hasLiveBounds(view: ActionsView | null): boolean {
  return (
    view?.items.some(
      (item) =>
        item.key !== null && item.fields.some((field) => field.live && field.type === 'number'),
    ) ?? false
  );
}

/**
 * R2: the bounds of a battle's live controls, keyed by control path like a run-controls read's
 * `constraints`. A number field of an addressable item takes its descriptor's bounds; every
 * other path keeps the saved run's `constraints` as read. Without a projection the saved
 * constraints are returned as they are.
 */
export function liveConstraints(view: ActionsView | null, saved: unknown): unknown {
  // A descriptor bound of null means the descriptor publishes no bound for that side; it is
  // not filled from the saved run (equal on every recorded pair, tests/core/actions.test.ts).
  if (view === null) return saved;
  const bounds: Record<string, { readonly min: number | null; readonly max: number | null }> = {};
  for (const item of view.items) {
    if (item.key === null) continue;
    for (const field of item.fields)
      if (field.live && field.type === 'number')
        bounds[`routines.${item.key}.${field.path}`] = { min: field.min, max: field.max };
  }
  return { ...Object.fromEntries(entries(saved)), ...bounds };
}
