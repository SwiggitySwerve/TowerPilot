import { createContext, useContext, useId, useState } from 'react';
import { copy } from '../../copy/catalogue.ts';
import type { CopyEntry, CopyNode } from '../../copy/text.ts';
import { actionName, COMPAT_FIELDS, fieldLabel } from '../../core/actions.ts';
import { ownOr } from '../../core/read.ts';
import type { ServerText } from '../../copy/server.ts';
import type {
  EditorVM,
  LiveResetAllVM,
  LiveResetVM,
  RunFieldVM,
  RunGroupVM,
  UnaddressableVM,
  UnrecognisedFieldVM,
} from '../../store/selectors/runs.ts';
import { Button } from '../../ui/Button.tsx';
import { ActionRow, Reason } from '../../ui/ActionRow.tsx';
import { Tile } from '../../ui/Tile.tsx';
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx';
import { ServerValue } from '../../ui/ServerValue.tsx';
import { Why } from '../../ui/Why.tsx';
import { useDashboard } from '../dashboard/context.ts';

const t = copy.runs;
const a = copy.actions;

/** A2-7 AC2: the descriptor's label when the battle sends one, else the catalogue's (Q5). */
function Label({
  server,
  code,
  table,
  other,
}: {
  readonly server: ServerText<'name'> | null;
  readonly code: string;
  readonly table: Readonly<Record<string, CopyEntry>>;
  readonly other: CopyEntry;
}) {
  return server === null ? (
    <>{fieldLabel(table, code, other).short}</>
  ) : (
    <ServerValue kind="name" value={server} />
  );
}

/**
 * A field's name. With catalogue labels the header names the columns on wide layouts and the
 * cell's label is for screen readers there; with descriptor labels every field shows its own.
 */
function FieldLabel({
  field,
  id,
  shown,
}: {
  readonly field: { readonly field: string; readonly label: ServerText<'name'> | null };
  readonly id: string;
  readonly shown: boolean;
}) {
  return (
    <span id={id} className={shown ? 'tp-run-cell__name' : 'tp-run-cell__label'}>
      <Label server={field.label} code={field.field} table={a.fields} other={a.otherField} />
    </span>
  );
}

/** An action's name: the projection's label when the battle sends one, else the catalogue's. */
function ActionName({
  routine,
  label,
}: {
  readonly routine: string;
  readonly label: ServerText<'name'> | null;
}) {
  return label === null ? (
    <>{actionName(a.names, routine, a.otherName).short}</>
  ) : (
    <ServerValue kind="name" value={label} />
  );
}

/** One switch (RUN-02): a native checkbox named by its routine and column. */
function ToggleCell({
  field,
  scope,
  nameId,
  shown,
}: {
  readonly field: RunFieldVM;
  readonly scope: string;
  readonly nameId: string;
  readonly shown: boolean;
}) {
  const { commands } = useDashboard();
  const own = useId();
  const checked = field.shown === true;
  return (
    <span className="tp-run-cell" data-field={field.field} data-edited={field.edited}>
      <FieldLabel field={field} id={`${own}-label`} shown={shown} />
      <label className="tp-check-field">
        <input
          type="checkbox"
          className="tp-run-toggle"
          checked={checked}
          aria-labelledby={`${nameId} ${own}-label`}
          aria-describedby={field.value === null ? `${own}-unknown` : undefined}
          data-focus-key={`${scope}:${field.path}`}
          onChange={(event) => {
            commands.editDraft(scope, field.path, event.currentTarget.checked);
          }}
        />
      </label>
      {field.value === null && field.shown === null ? (
        <span id={`${own}-unknown`} className="tp-run-cell__note">
          {t.notReported.short}
        </span>
      ) : null}
    </span>
  );
}

/** One number (RUN-02, RUN-04): typed text kept as typed, its unit, range, duration and reason. */
function NumberCell({
  field,
  scope,
  nameId,
  shown: labelShown,
}: {
  readonly field: RunFieldVM;
  readonly scope: string;
  readonly nameId: string;
  readonly shown: boolean;
}) {
  const { commands } = useDashboard();
  const own = useId();
  const shown = typeof field.shown === 'string' ? field.shown : '';
  const parsed = field.invalid === null && shown !== '' ? Number(shown) : NaN;
  return (
    <span
      className="tp-run-cell"
      data-field={field.field}
      data-edited={field.edited}
      data-invalid={field.invalid !== null}
    >
      <FieldLabel field={field} id={`${own}-label`} shown={labelShown} />
      <span className="tp-run-number">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          className="tp-run-input tp-field-control"
          value={shown}
          aria-labelledby={`${nameId} ${own}-label`}
          aria-describedby={`${own}-range${field.invalid === null ? '' : ` ${own}-invalid`}`}
          aria-invalid={field.invalid === null ? undefined : true}
          data-focus-key={`${scope}:${field.path}`}
          onChange={(event) => {
            commands.editDraft(scope, field.path, event.currentTarget.value);
          }}
        />
        <Unit field={field} />
        {field.unit.kind === 'seconds' && Number.isFinite(parsed) && parsed >= 60 ? (
          // Root note (390): the duration is one unbroken note beside the unit.
          <span className="tp-run-cell__note tp-run-cell__duration">{t.duration(parsed)}</span>
        ) : null}
      </span>
      <span id={`${own}-range`} className="tp-run-cell__note">
        <Range field={field} />
      </span>
      {field.invalid === null ? null : (
        <span id={`${own}-invalid`} className="tp-run-cell__invalid">
          {t.invalid[field.invalid].short}
        </span>
      )}
    </span>
  );
}

/** A2-7 AC2: the unit after a number: seconds from the catalogue, else the descriptor's as sent. */
function Unit({ field }: { readonly field: RunFieldVM }) {
  if (field.unit.kind === 'none') return null;
  return (
    <span className="tp-run-cell__unit">
      {field.unit.kind === 'seconds' ? (
        t.seconds.short
      ) : (
        <ServerValue kind="name" value={field.unit.text} />
      )}
    </span>
  );
}

/** A number's range with its unit (seconds as before; another unit as sent; none without one). */
function Range({ field }: { readonly field: RunFieldVM }) {
  if (field.unit.kind === 'seconds') return <>{t.range(field.min, field.max)}</>;
  const bounded = field.min !== null || field.max !== null;
  return (
    <>
      {t.bounds(field.min, field.max, field.unit.kind === 'other')}
      {field.unit.kind === 'other' && bounded ? (
        <ServerValue kind="name" value={field.unit.text} />
      ) : null}
    </>
  );
}

/** A2-7 AC2: a setting whose descriptor type the page does not know: its name, never an input. */
function UnrecognisedCell({ field }: { readonly field: UnrecognisedFieldVM }) {
  const own = useId();
  return (
    <span className="tp-run-cell" data-field={field.field} data-unrecognised={field.path}>
      <FieldLabel field={field} id={`${own}-label`} shown />
      <span className="tp-run-cell__note">
        <span>{t.live.unrecognised.short}</span>
        {t.live.unrecognised.why === undefined ? null : <Why why={t.live.unrecognised.why} />}
        {field.type === null ? null : <ServerValue kind="id" value={field.type} />}
      </span>
    </span>
  );
}

function RoutineRow({
  group,
  scope,
  live,
  described,
  resets,
}: {
  readonly group: RunGroupVM;
  readonly scope: string;
  readonly live: boolean;
  /** A2-7 AC2: descriptor labels: every field shows its name, in descriptor order. */
  readonly described: boolean;
  /** This battle's overrides of this routine, each with its undo, at the end of the row. */
  readonly resets: readonly LiveResetVM[];
}) {
  const own = useId();
  const nameId = `${own}-name`;

  const marks = live
    ? group.fields.flatMap((f) => (f.mark === null || f.mark === 'saved' ? [] : [f.mark]))
    : [];
  const mark = marks.includes('waiting') ? 'waiting' : marks.includes('changed') ? 'changed' : null;
  const edited = group.fields.some((f) => f.edited);
  return (
    <li className="tp-run-row" data-routine={group.routine} data-edited={edited}>
      <span className="tp-run-row__head">
        <strong id={nameId} className="tp-run-row__name">
          <ActionName routine={group.routine} label={group.label} />
        </strong>
        {/* A change is named, with its undo, at the end of the row; a change still waiting to
            apply has no undo, so it is marked under the name. */}
        {mark === 'changed' ? (
          <span className="tp-visually-hidden">{t.live.marks.changed.short}</span>
        ) : mark === null ? null : (
          <span className="tp-run-row__mark">
            <span>{t.live.marks[mark].short}</span>
            <Why why={t.live.marks[mark].why} />
          </span>
        )}
        {edited ? <span className="tp-run-row__edited">{t.edited.short}</span> : null}
      </span>
      {described ? (
        <span className="tp-run-fields">
          {group.cells.map((cell) =>
            cell.kind === 'field' ? (
              fieldCell(cell.field, scope, nameId, true)
            ) : (
              <UnrecognisedCell key={cell.field.path} field={cell.field} />
            ),
          )}
        </span>
      ) : (
        group.fields.map((field) => fieldCell(field, scope, nameId, false))
      )}
      <RowResets resets={resets} />
    </li>
  );
}

function fieldCell(field: RunFieldVM, scope: string, nameId: string, shown: boolean) {
  return field.kind === 'toggle' ? (
    <ToggleCell key={field.path} field={field} scope={scope} nameId={nameId} shown={shown} />
  ) : (
    <NumberCell key={field.path} field={field} scope={scope} nameId={nameId} shown={shown} />
  );
}

/** A routine whose only control is its switch (Rewards, Abilities, Rescue, Repeat). */
function switchOnly(group: RunGroupVM): boolean {
  return (
    group.cells.length === 1 && group.fields.length === 1 && group.fields[0]?.kind === 'toggle'
  );
}

/** A2-7 AC2 (gap G2): an action whose settings the battle does not address: its name and why. */
function UnaddressableRow({ item }: { readonly item: UnaddressableVM }) {
  const why = t.live.unaddressable.why;
  return (
    <li className="tp-run-row tp-run-row--read-only" data-unaddressable={item.reason}>
      <strong className="tp-run-row__name">
        <ActionName routine={item.id} label={item.label} />
      </strong>
      <span className="tp-run-row__reason">
        <span>{t.live.unaddressable.short}</span>
        {why === undefined ? null : <Why why={why} />}
      </span>
    </li>
  );
}

/**
 * RUN-02 (council annotation: no card or row for a single switch): the
 * switch-only routines share one row, each switch named by its routine.
 */
function SwitchRow({
  groups,
  scope,
  live,
  resets,
}: {
  readonly groups: readonly RunGroupVM[];
  readonly scope: string;
  readonly live: boolean;
  /** The switches' overrides, each with its undo, beside its own switch. */
  readonly resets: readonly LiveResetVM[];
}) {
  const { commands } = useDashboard();
  const own = useId();
  return (
    <li className="tp-run-row tp-run-row--switches">
      <div className="tp-run-switches">
        {groups.map((group) => (
          <div key={group.routine} className="tp-run-switch-cell">
            {group.fields.map((field) => (
              <label
                key={field.path}
                className="tp-run-switch"
                data-routine={group.routine}
                data-edited={field.edited}
              >
                <input
                  type="checkbox"
                  className="tp-run-toggle"
                  checked={field.shown === true}
                  data-focus-key={`${scope}:${field.path}`}
                  aria-describedby={field.value === null ? `${own}-${group.routine}` : undefined}
                  onChange={(event) => {
                    commands.editDraft(scope, field.path, event.currentTarget.checked);
                  }}
                />
                <span>
                  <ActionName routine={group.routine} label={group.label} />
                </span>
                {field.value === null && field.shown === null ? (
                  <span id={`${own}-${group.routine}`} className="tp-run-cell__note">
                    {t.notReported.short}
                  </span>
                ) : null}
                {/* A change is named, with its undo, beside the switch; a change still waiting to
                  apply has no undo, so it is marked on the switch itself. */}
                {!live || field.mark === null || field.mark === 'saved' ? null : field.mark ===
                  'changed' ? (
                  <span className="tp-visually-hidden">{t.live.marks.changed.short}</span>
                ) : (
                  <span className="tp-run-row__mark">
                    <span>{t.live.marks.waiting.short}</span>
                    <Why why={t.live.marks.waiting.why} />
                  </span>
                )}
              </label>
            ))}
            <RowResets resets={resets.filter((item) => item.routine === group.routine)} />
          </div>
        ))}
      </div>
    </li>
  );
}

function ResetRow({
  item,
  onAsk,
}: {
  readonly item: LiveResetVM;
  readonly onAsk: (item: LiveResetVM) => void;
}) {
  const own = useId();
  const reasons: Readonly<Record<string, CopyEntry>> = t.reasons;
  const reset = item.reset;
  return (
    <li className="tp-run-reset" data-path={item.path}>
      <span id={`${own}-name`} className="tp-run-reset__name">
        <OverrideName item={item} />
      </span>
      {reset.enabled ? (
        <Button
          tier="quiet"
          label={t.live.overrides.reset.short}
          focusKey={`reset:${item.path}`}
          targetId={`${own}-name`}
          onClick={() => {
            onAsk(item);
          }}
        />
      ) : (
        <>
          <Button
            tier="quiet"
            label={t.live.overrides.reset.short}
            focusKey={`reset:${item.path}`}
            targetId={`${own}-name`}
            busy={reset.sending}
            disabled
            reasonId={`${own}-reason`}
            onClick={() => undefined}
          />
          <span id={`${own}-reason`} className="tp-reason">
            {ownOr(reasons, reset.reason ?? 'no_changes', t.reasons.no_changes).short}
          </span>
        </>
      )}
    </li>
  );
}

/** Opens the confirmation of one override's reset; null outside a live editor. */
const ResetAsk = createContext<((item: LiveResetVM) => void) | null>(null);

/** The overrides of one row, each with "Use starting value", beside what they change. */
function RowResets({ resets }: { readonly resets: readonly LiveResetVM[] }) {
  const ask = useContext(ResetAsk);
  if (ask === null || resets.length === 0) return null;
  return (
    <ul className="tp-run-resets__list tp-run-row__resets">
      {resets.map((item) => (
        <ResetRow key={item.path} item={item} onAsk={ask} />
      ))}
    </ul>
  );
}

/** The routine and field names of one override, as one line. */
function OverrideName({
  item,
}: {
  readonly item:
    | {
        readonly routine: string;
        readonly field: string;
        readonly routineLabel: ServerText<'name'> | null;
        readonly label: ServerText<'name'> | null;
        readonly value?: boolean | number | null;
      }
    | { readonly kind: 'shopping_plan' };
}) {
  if (!('routine' in item)) return <span>{t.live.overrides.shoppingPlan.short}</span>;
  const o = t.live.overrides;
  return (
    <>
      <span>
        <ActionName routine={item.routine} label={item.routineLabel} />
      </span>
      <span>
        {/* A switch's override says its side; the routine's name already names the switch. */}
        {item.field === 'enabled' && typeof item.value === 'boolean' ? (
          (item.value ? o.turnedOn : o.turnedOff).short
        ) : item.field === 'enabled' && item.label === null ? (
          o.onOff.short
        ) : (
          <Label server={item.label} code={item.field} table={a.fields} other={a.otherField} />
        )}
      </span>
    </>
  );
}

/**
 * Where the resets without a row of their own stand: a titled group when it lists any; with
 * every override named in its own row, the undo-all stands alone with no heading over it.
 */
function ResetsGroup({
  rowless,
  titleId,
  children,
}: {
  readonly rowless: boolean;
  readonly titleId: string;
  readonly children: CopyNode;
}) {
  const o = t.live.overrides;
  return rowless ? (
    <Tile
      className="tp-run-resets"
      titleId={titleId}
      title={o.title.short}
      level={4}
      end={<Why why={o.title.why} />}
    >
      {children}
    </Tile>
  ) : (
    <div className="tp-run-resets">{children}</div>
  );
}

/** What an open confirmation was opened for: one override, or all of them (RL2). */
type Asking =
  | { readonly kind: 'one'; readonly target: string | null }
  | { readonly kind: 'all'; readonly target: string | null };

/**
 * F6-11 RL1 and RL2 (spec F-060, RUN-15): this battle's overrides, each with "Use the battle's
 * starting value" in its own routine's row (one with no row is listed here), and with two or
 * more a reset of all of them in one request, each behind a confirmation that says what that
 * value is relative to.
 */
function LiveResets({
  resets,
  resetAll,
  rows,
  children,
}: {
  readonly resets: readonly LiveResetVM[];
  readonly resetAll: LiveResetAllVM | null;
  /** The routines that have a row of their own in the table. */
  readonly rows: ReadonlySet<string>;
  /** The routine table, whose rows show their own overrides. */
  readonly children: CopyNode;
}) {
  const { commands } = useDashboard();
  const own = useId();
  const [asking, setAsking] = useState<Asking | null>(null);
  const titleId = useId();
  // A confirmation applies only to the target it was opened for (review F6-11-R1-01): when the
  // reset is no longer offered, or would now go to another battle, generation, revision or set
  // of paths, it closes and sends nothing.
  const offered = (target: string | null, reset: { readonly enabled: boolean }) =>
    asking !== null && asking.target !== null && target === asking.target && reset.enabled;
  const current =
    asking?.kind === 'one'
      ? (resets.find((item) => offered(item.target, item.reset)) ?? null)
      : null;
  const all =
    asking?.kind === 'all' && resetAll !== null && offered(resetAll.target, resetAll.reset)
      ? resetAll
      : null;
  if (asking !== null && current === null && all === null) setAsking(null);
  const o = t.live.overrides;
  const command = current?.reset.command ?? all?.reset.command ?? null;
  const ask = (asked: LiveResetVM) => {
    setAsking({ kind: 'one', target: asked.target });
  };
  const rowless = resets.filter((item) => !rows.has(item.routine));
  return (
    <>
      <ResetAsk.Provider value={ask}>{children}</ResetAsk.Provider>
      {rowless.length === 0 && resetAll === null ? null : (
        <ResetsGroup rowless={rowless.length > 0} titleId={titleId}>
          {rowless.length === 0 ? null : (
            <ul className="tp-run-resets__list">
              {rowless.map((item) => (
                <ResetRow key={item.path} item={item} onAsk={ask} />
              ))}
            </ul>
          )}
          {resetAll === null ? null : (
            <div className="tp-run-reset tp-run-reset--all" data-reset-all="true">
              {/* The undo-all names its items in its confirmation (one may have no row above). */}
              {resetAll.reset.enabled ? (
                <Button
                  tier="quiet"
                  label={o.resetAll(resetAll.items.length)}
                  focusKey="reset:all"
                  onClick={() => {
                    setAsking({ kind: 'all', target: resetAll.target });
                  }}
                />
              ) : (
                <>
                  <Button
                    tier="quiet"
                    label={o.resetAll(resetAll.items.length)}
                    focusKey="reset:all"
                    busy={resetAll.reset.sending}
                    disabled
                    reasonId={`${own}-all-reason`}
                    onClick={() => undefined}
                  />
                  <span id={`${own}-all-reason`} className="tp-reason">
                    {
                      ownOr(t.reasons, resetAll.reset.reason ?? 'no_changes', t.reasons.no_changes)
                        .short
                    }
                  </span>
                </>
              )}
              {rowless.length > 0 ? null : <Why why={o.title.why} />}
            </div>
          )}
        </ResetsGroup>
      )}
      <ConfirmDialog
        open={asking !== null}
        tier="primary"
        title={all === null ? o.confirm.short : o.confirmAll.short}
        body={
          <>
            {current === null ? null : (
              <p className="tp-run-reset__name">
                <OverrideName item={current} />
              </p>
            )}
            {all === null ? null : (
              <ul className="tp-run-resets__confirm-list">
                {all.items.map((item) => (
                  <li key={item.path} className="tp-run-reset__name">
                    <OverrideName item={item} />
                  </li>
                ))}
              </ul>
            )}
            <p>{all === null ? o.effect.short : o.effectAll.short}</p>
          </>
        }
        confirmLabel={all === null ? o.send.short : o.sendAll.short}
        cancelLabel={o.cancel.short}
        onCancel={() => {
          setAsking(null);
        }}
        onConfirm={() => {
          setAsking(null);
          if (command !== null && (current !== null || all !== null))
            void commands.resetLive(command);
        }}
      />
    </>
  );
}

/**
 * One editor (RUN-02 to RUN-05, RUN-08): the routine rows of a scope, then its
 * Save and Discard. Save is enabled only when core's gate allows it; a
 * disabled Save names its visible reason.
 */
export function RunEditor<C>({
  editor,
  live,
  saveLabel,
  onSave,
  extra,
}: {
  readonly editor: EditorVM<C>;
  readonly live: boolean;
  readonly saveLabel: CopyEntry;
  readonly onSave: (command: C) => void;
  /** One more action after Save and Discard (the saved editor's "Check saved values", a read). */
  readonly extra?: CopyNode;
}) {
  const { commands } = useDashboard();
  const own = useId();
  const reasonId = `${own}-reason`;
  const save = editor.save;
  const command = save.command;
  const reasons: Readonly<Record<string, CopyEntry>> = t.reasons;
  const described = editor.labels === 'descriptor';
  const resetsOf = (routines: readonly string[]) =>
    live ? editor.resets.filter((item) => routines.includes(item.routine)) : [];
  const switches = editor.groups.filter(switchOnly);
  const rows = (
    <ul className="tp-run-rows">
      {editor.groups
        .filter((group) => !switchOnly(group))
        .map((group) => (
          <RoutineRow
            key={group.routine}
            group={group}
            scope={editor.scope}
            live={live}
            described={described}
            resets={resetsOf([group.routine])}
          />
        ))}
      {editor.unaddressable.map((item) => (
        <UnaddressableRow key={`${item.id}@${item.instance}`} item={item} />
      ))}
      {switches.length > 0 ? (
        <SwitchRow
          groups={switches}
          scope={editor.scope}
          live={live}
          resets={resetsOf(switches.map((group) => group.routine))}
        />
      ) : null}
    </ul>
  );
  return (
    <div
      className="tp-run-editor"
      data-scope-kind={live ? 'live' : 'saved'}
      data-labels={editor.labels}
    >
      {described ? null : (
        // Catalogue labels (the saved editor, Q5; a battle without a projection): one header.
        <div className="tp-run-columns" aria-hidden="true">
          <span>{copy.dashboard.thisBattle.columns.routine.short}</span>
          {COMPAT_FIELDS.map((column) => (
            <span key={column}>{fieldLabel(a.fields, column, a.otherField).short}</span>
          ))}
        </div>
      )}
      {live ? (
        <LiveResets
          resets={editor.resets}
          resetAll={editor.resetAll}
          rows={new Set(editor.groups.map((group) => group.routine))}
        >
          {rows}
        </LiveResets>
      ) : (
        rows
      )}
      <div className="tp-run-editor__actions">
        <ActionRow
          reason={
            save.enabled ? null : (
              <Reason
                id={reasonId}
                entry={ownOr(reasons, save.reason ?? 'no_changes', t.reasons.no_changes)}
              />
            )
          }
        >
          {save.enabled && command !== null ? (
            <Button
              tier="secondary"
              label={saveLabel.short}
              focusKey={`${editor.scope}:save`}
              describedBy={`${own}-count`}
              onClick={() => {
                onSave(command);
              }}
            />
          ) : (
            <Button
              tier="secondary"
              label={saveLabel.short}
              focusKey={`${editor.scope}:save`}
              busy={save.sending}
              disabled
              reasonId={reasonId}
              onClick={() => undefined}
            />
          )}
          {editor.discard ? (
            <Button
              tier="quiet"
              label={t.discard.short}
              focusKey={`${editor.scope}:discard`}
              onClick={() => {
                commands.discardDraft(editor.scope);
              }}
            />
          ) : null}
          {extra}
          <span id={`${own}-count`} className="tp-run-editor__count">
            {editor.changeCount > 0 ? t.changes(editor.changeCount) : null}
          </span>
        </ActionRow>
      </div>
    </div>
  );
}
