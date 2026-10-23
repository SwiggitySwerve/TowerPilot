import { useId, useState } from 'react';
import { copy } from '../../copy/catalogue.ts';
import type { CopyEntry, CopyNode } from '../../copy/text.ts';
import { actionName, COMPAT_FIELDS, fieldLabel } from '../../core/actions.ts';
import { ownOr } from '../../core/read.ts';
import type {
  EditorVM,
  LiveResetAllVM,
  LiveResetVM,
  RunFieldVM,
  RunGroupVM,
} from '../../store/selectors/runs.ts';
import { Button } from '../../ui/Button.tsx';
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx';
import { Why } from '../../ui/Why.tsx';
import { useDashboard } from '../dashboard/context.ts';

const t = copy.runs;
const a = copy.actions;

function FieldLabel({ field, id }: { readonly field: RunFieldVM; readonly id: string }) {
  const label = fieldLabel(a.fields, field.field, a.otherField);
  return (
    <span id={id} className="tp-run-cell__label">
      {label.short}
    </span>
  );
}

/** One switch (RUN-02): a native checkbox named by its routine and column. */
function ToggleCell({
  field,
  scope,
  nameId,
}: {
  readonly field: RunFieldVM;
  readonly scope: string;
  readonly nameId: string;
}) {
  const { commands } = useDashboard();
  const own = useId();
  const checked = field.shown === true;
  return (
    <span className="tp-run-cell" data-field={field.field} data-edited={field.edited}>
      <FieldLabel field={field} id={`${own}-label`} />
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
}: {
  readonly field: RunFieldVM;
  readonly scope: string;
  readonly nameId: string;
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
      <FieldLabel field={field} id={`${own}-label`} />
      <span className="tp-run-number">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          className="tp-run-input"
          value={shown}
          aria-labelledby={`${nameId} ${own}-label`}
          aria-describedby={`${own}-range${field.invalid === null ? '' : ` ${own}-invalid`}`}
          aria-invalid={field.invalid === null ? undefined : true}
          data-focus-key={`${scope}:${field.path}`}
          onChange={(event) => {
            commands.editDraft(scope, field.path, event.currentTarget.value);
          }}
        />
        <span className="tp-run-cell__unit">{t.seconds.short}</span>
        {Number.isFinite(parsed) && parsed >= 60 ? (
          <span className="tp-run-cell__note">{t.duration(parsed)}</span>
        ) : null}
      </span>
      <span id={`${own}-range`} className="tp-run-cell__note">
        {t.range(field.min, field.max)}
      </span>
      {field.invalid === null ? null : (
        <span id={`${own}-invalid`} className="tp-run-cell__invalid">
          {t.invalid[field.invalid].short}
        </span>
      )}
    </span>
  );
}

function RoutineRow({
  group,
  scope,
  live,
}: {
  readonly group: RunGroupVM;
  readonly scope: string;
  readonly live: boolean;
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
      <strong id={nameId} className="tp-run-row__name">
        {actionName(a.names, group.routine, a.otherName).short}
      </strong>
      {group.fields.map((field) =>
        field.kind === 'toggle' ? (
          <ToggleCell key={field.path} field={field} scope={scope} nameId={nameId} />
        ) : (
          <NumberCell key={field.path} field={field} scope={scope} nameId={nameId} />
        ),
      )}
      <span className="tp-run-row__mark">
        {mark === null ? null : (
          <>
            <span>{t.live.marks[mark].short}</span>
            <Why why={t.live.marks[mark].why} />
          </>
        )}
        {edited ? <span className="tp-run-row__edited">{t.edited.short}</span> : null}
      </span>
    </li>
  );
}

/** A routine whose only control is its switch (Rewards, Abilities, Rescue, Repeat). */
function switchOnly(group: RunGroupVM): boolean {
  return group.fields.length === 1 && group.fields[0]?.kind === 'toggle';
}

/**
 * RUN-02 (council annotation: no card or row for a single switch): the
 * switch-only routines share one row, each switch named by its routine.
 */
function SwitchRow({
  groups,
  scope,
  live,
}: {
  readonly groups: readonly RunGroupVM[];
  readonly scope: string;
  readonly live: boolean;
}) {
  const { commands } = useDashboard();
  const own = useId();
  return (
    <li className="tp-run-row tp-run-row--switches">
      <span className="tp-run-switches">
        {groups.map((group) =>
          group.fields.map((field) => (
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
              <span>{actionName(a.names, group.routine, a.otherName).short}</span>
              {field.value === null && field.shown === null ? (
                <span id={`${own}-${group.routine}`} className="tp-run-cell__note">
                  {t.notReported.short}
                </span>
              ) : null}
              {live && field.mark !== null && field.mark !== 'saved' ? (
                <span className="tp-run-cell__note">{t.live.marks[field.mark].short}</span>
              ) : null}
            </label>
          )),
        )}
      </span>
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

/** The routine and field names of one override, as one line. */
function OverrideName({
  item,
}: {
  readonly item:
    { readonly routine: string; readonly field: string } | { readonly kind: 'shopping_plan' };
}) {
  if (!('routine' in item)) return <span>{t.live.overrides.shoppingPlan.short}</span>;
  return (
    <>
      <span>{actionName(a.names, item.routine, a.otherName).short}</span>
      <span>{fieldLabel(a.fields, item.field, a.otherField).short}</span>
    </>
  );
}

/** What an open confirmation was opened for: one override, or all of them (RL2). */
type Asking =
  | { readonly kind: 'one'; readonly target: string | null }
  | { readonly kind: 'all'; readonly target: string | null };

/**
 * F6-11 RL1 and RL2 (spec F-060, RUN-15): this battle's overrides, each with "Use the battle's
 * starting value", and with two or more a reset of all of them in one request, each behind a
 * confirmation that says what that value is relative to.
 */
function LiveResets({
  resets,
  resetAll,
}: {
  readonly resets: readonly LiveResetVM[];
  readonly resetAll: LiveResetAllVM | null;
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
  if (resets.length === 0 && resetAll === null) return null;
  const o = t.live.overrides;
  const command = current?.reset.command ?? all?.reset.command ?? null;
  return (
    <section className="tp-run-resets" aria-labelledby={titleId}>
      <h3 id={titleId} className="tp-run-resets__title">
        <span>{o.title.short}</span>
        {o.title.why === undefined ? null : <Why why={o.title.why} />}
      </h3>
      <ul className="tp-run-resets__list">
        {resets.map((item) => (
          <ResetRow
            key={item.path}
            item={item}
            onAsk={(asked) => {
              setAsking({ kind: 'one', target: asked.target });
            }}
          />
        ))}
      </ul>
      {resetAll === null ? null : (
        <div className="tp-run-reset tp-run-reset--all" data-reset-all="true">
          <ul className="tp-run-resets__confirm-list" data-reset-all-items="true">
            {resetAll.items.map((item) => (
              <li key={item.path} className="tp-run-reset__name">
                <OverrideName item={item} />
              </li>
            ))}
          </ul>
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
        </div>
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
    </section>
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
  return (
    <div className="tp-run-editor" data-scope-kind={live ? 'live' : 'saved'}>
      <div className="tp-run-columns" aria-hidden="true">
        <span>{copy.dashboard.thisBattle.columns.routine.short}</span>
        {COMPAT_FIELDS.map((column) => (
          <span key={column}>{fieldLabel(a.fields, column, a.otherField).short}</span>
        ))}
      </div>
      <ul className="tp-run-rows">
        {editor.groups
          .filter((group) => !switchOnly(group))
          .map((group) => (
            <RoutineRow key={group.routine} group={group} scope={editor.scope} live={live} />
          ))}
        {editor.groups.some(switchOnly) ? (
          <SwitchRow groups={editor.groups.filter(switchOnly)} scope={editor.scope} live={live} />
        ) : null}
      </ul>
      {live ? <LiveResets resets={editor.resets} resetAll={editor.resetAll} /> : null}
      <div className="tp-run-editor__actions">
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
        {save.enabled ? null : (
          <span id={reasonId} className="tp-reason">
            {ownOr(reasons, save.reason ?? 'no_changes', t.reasons.no_changes).short}
          </span>
        )}
      </div>
    </div>
  );
}
