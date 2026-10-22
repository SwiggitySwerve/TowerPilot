import { useId } from 'react';
import { copy } from '../../copy/catalogue.ts';
import type { CopyEntry, CopyNode } from '../../copy/text.ts';
import type { EditorVM, RunFieldVM, RunGroupVM } from '../../store/selectors/runs.ts';
import { Button } from '../../ui/Button.tsx';
import { Why } from '../../ui/Why.tsx';
import { useDashboard } from '../dashboard/context.ts';

const t = copy.runs;
const COLUMNS = ['enabled', 'interval_sec', 'window_sec', 'tap_interval_sec'] as const;
const COLUMN_SET: ReadonlySet<string> = new Set(COLUMNS);

function entryOf(entries: Readonly<Record<string, CopyEntry>>, code: string, fallback: CopyEntry) {
  return Object.hasOwn(entries, code) ? (entries[code] ?? fallback) : fallback;
}

function FieldLabel({ field, id }: { readonly field: RunFieldVM; readonly id: string }) {
  const label = entryOf(t.fields, field.field, t.otherField);
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
  const known = COLUMNS.filter((column) => group.fields.some((f) => f.field === column));
  const ordered = [
    ...known.flatMap((column) => group.fields.filter((f) => f.field === column)),
    ...group.fields.filter((f) => !COLUMN_SET.has(f.field)),
  ];
  const marks = live
    ? group.fields.flatMap((f) => (f.mark === null || f.mark === 'saved' ? [] : [f.mark]))
    : [];
  const mark = marks.includes('waiting') ? 'waiting' : marks.includes('changed') ? 'changed' : null;
  const edited = group.fields.some((f) => f.edited);
  return (
    <li className="tp-run-row" data-routine={group.routine} data-edited={edited}>
      <strong id={nameId} className="tp-run-row__name">
        {entryOf(t.routines, group.routine, t.otherRoutine).short}
      </strong>
      {ordered.map((field) =>
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
              <span>{entryOf(t.routines, group.routine, t.otherRoutine).short}</span>
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
        {COLUMNS.map((column) => (
          <span key={column}>{t.fields[column].short}</span>
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
            {entryOf(reasons, save.reason ?? 'no_changes', t.reasons.no_changes).short}
          </span>
        )}
      </div>
    </div>
  );
}
