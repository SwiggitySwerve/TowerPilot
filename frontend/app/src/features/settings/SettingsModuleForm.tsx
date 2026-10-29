import { useId } from 'react';
import { settings as t } from '../../copy/settings.ts';
import { settingsList as lists } from '../../copy/settingsList.ts';
import type { CopyEntry } from '../../copy/text.ts';
import type {
  SettingsFieldVM,
  SettingsModuleVM,
  SettingsPartVM,
  SettingsSaveCommand,
} from '../../store/selectors/settingsModule.ts';
import { Button } from '../../ui/Button.tsx';
import { Disclosure } from '../../ui/Disclosure.tsx';
import { ServerOption, ServerValue } from '../../ui/ServerValue.tsx';
import { Why } from '../../ui/Why.tsx';
import { SaveOutcome } from './SaveOutcome.tsx';
import './settings.css';

export interface SettingsModuleFormProps {
  readonly vm: SettingsModuleVM;
  /** The legend: the page's own wording, else the server's module title. */
  readonly legend?: CopyEntry;
  /** A line under the legend (what the timers mean, what is spent). */
  readonly intro?: CopyEntry;
  /** Field paths drawn inside one disclosure (advanced geometry), with its label. */
  readonly advanced?: { readonly label: CopyEntry; readonly paths: readonly string[] };
  /** A note beside a field (by path), shown while the field's draft is on (a spending choice). */
  readonly notes?: Readonly<Record<string, CopyEntry>>;
  readonly onEdit: (scope: string, key: string, value: string | boolean) => void;
  readonly onDiscard: (scope: string) => void;
  readonly onSave: (command: SettingsSaveCommand) => void;
  readonly onDismiss: (id: string) => void;
}

function reasonOf(reason: string | null): CopyEntry {
  const reasons: Readonly<Record<string, CopyEntry>> = t.reasons;
  return (reason === null ? undefined : reasons[reason]) ?? t.reasons.context_unknown;
}

function PartInput({
  field,
  part,
  index,
  labelId,
  partLabel,
  errorId,
  scope,
  onEdit,
}: {
  readonly field: SettingsFieldVM;
  readonly part: SettingsPartVM;
  readonly index: number;
  readonly labelId: string;
  readonly partLabel: CopyEntry | null;
  readonly errorId: string | null;
  readonly scope: string | null;
  readonly onEdit: SettingsModuleFormProps['onEdit'];
}) {
  const own = useId();
  const invalid =
    field.invalid !== null && (field.invalid.part === null || field.invalid.part === index);
  return (
    <span className="tp-settings__part">
      {partLabel === null ? null : (
        <span id={`${own}-part`} className="tp-settings__part-label">
          {partLabel.short}
        </span>
      )}
      <input
        type="text"
        inputMode={
          field.type === 'number' ||
          field.type === 'integer' ||
          field.type === 'range' ||
          field.type === 'point'
            ? 'decimal'
            : undefined
        }
        className="tp-settings__input"
        autoComplete="off"
        spellCheck={false}
        value={typeof part.raw === 'string' ? part.raw : ''}
        disabled={scope === null}
        aria-labelledby={partLabel === null ? labelId : `${labelId} ${own}-part`}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={invalid && errorId !== null ? errorId : undefined}
        data-focus-key={`${scope ?? 'none'}:${part.key}`}
        data-part={part.key}
        onChange={(event) => {
          if (scope !== null) onEdit(scope, part.key, event.currentTarget.value);
        }}
      />
    </span>
  );
}

/**
 * One settings field (boolean, number, integer, range, point, enum, string) drawn from
 * its view model (store/selectors/settingsModule.ts settingsFieldVM). `scope` is the draft
 * scope edits go to (null: read-only); `onEdit(scope, key, value)` records a raw edit.
 */
export function SettingsField({
  field,
  scope,
  note,
  onEdit,
}: {
  readonly field: SettingsFieldVM;
  readonly scope: string | null;
  readonly note: CopyEntry | null;
  readonly onEdit: SettingsModuleFormProps['onEdit'];
}) {
  const own = useId();
  const labelId = `${own}-label`;
  const errorId = field.invalid === null ? null : `${own}-error`;
  const label = field.label === null ? null : <ServerValue kind="name" value={field.label} />;
  const help = (
    <>
      {field.description === null ? null : (
        <span className="tp-settings__help">
          <ServerValue kind="message" value={field.description} />
        </span>
      )}
      {field.invalid === null ? null : (
        <span id={errorId ?? undefined} className="tp-settings__invalid">
          {t.invalid[field.invalid.reason].short}
        </span>
      )}
    </>
  );
  if (field.type === 'string-list') {
    const edit = (key: string, value: string | boolean) => {
      if (scope === null) return;
      onEdit(scope, field.listSource.key, field.listSource.raw);
      onEdit(scope, field.path, true);
      onEdit(scope, key, value);
    };
    return (
      <fieldset className="tp-settings__field" data-field={field.path}>
        <legend id={labelId}>{label}</legend>
        {field.listRows.map((row, index) => (
          <div key={row.key} className="tp-settings__list-row">
            <label htmlFor={`${own}-${row.key}`}>
              <span id={`${own}-${row.key}-label`}>{lists.entry(index)}</span>
            </label>
            <input
              id={`${own}-${row.key}`}
              type="text"
              inputMode="text"
              className="tp-settings__input"
              value={row.raw}
              disabled={scope === null}
              aria-labelledby={`${labelId} ${own}-${row.key}-label`}
              aria-invalid={field.invalid === null ? undefined : true}
              aria-describedby={
                [errorId, row.malformed ? `${own}-${row.key}-malformed` : null]
                  .filter((id) => id !== null)
                  .join(' ') || undefined
              }
              onChange={(event) => {
                edit(row.key, event.currentTarget.value);
              }}
            />
            <button
              className="tp-button"
              type="button"
              disabled={scope === null}
              aria-labelledby={`${own}-${row.key}-remove ${labelId} ${own}-${row.key}-label ${own}-${row.key}-value`}
              onClick={() => {
                edit(row.key, false);
              }}
            >
              <span id={`${own}-${row.key}-remove`}>{lists.remove.short}</span>
            </button>
            <span id={`${own}-${row.key}-value`} hidden>
              {row.name === null ? null : <ServerValue kind="name" value={row.name} />}
            </span>
            {row.malformed ? (
              <span id={`${own}-${row.key}-malformed`}>{lists.malformed.short}</span>
            ) : null}
          </div>
        ))}
        <button
          className="tp-button"
          type="button"
          disabled={scope === null}
          aria-labelledby={`${own}-add ${labelId}`}
          onClick={() => {
            edit(field.nextListKey, '');
          }}
        >
          <span id={`${own}-add`}>{lists.add.short}</span>
        </button>
        {field.invalid === null ? null : (
          <span id={errorId ?? undefined} role="alert">
            {lists.listInvalid.short}
          </span>
        )}
        {field.description === null ? null : (
          <ServerValue kind="message" value={field.description} />
        )}
      </fieldset>
    );
  }
  if (field.type === 'boolean') {
    const part = field.parts[0];
    const on = part?.raw === true;
    return (
      <div className="tp-settings__field tp-settings__field--check" data-field={field.path}>
        <label className="tp-settings__check">
          <input
            type="checkbox"
            checked={on}
            disabled={scope === null}
            data-focus-key={`${scope ?? 'none'}:${field.path}`}
            onChange={(event) => {
              if (scope !== null && part !== undefined)
                onEdit(scope, part.key, event.currentTarget.checked);
            }}
          />
          <span id={labelId}>{label}</span>
        </label>
        {on && note !== null ? (
          <span className="tp-settings__note" data-note={field.path}>
            <span>{note.short}</span>
            {note.why === undefined ? null : <Why why={note.why} />}
          </span>
        ) : null}
        {help}
      </div>
    );
  }
  if (field.type === 'enum') {
    const part = field.parts[0];
    return (
      <div className="tp-settings__field" data-field={field.path}>
        <span id={labelId} className="tp-settings__label">
          {label}
        </span>
        <select
          value={typeof part?.raw === 'string' ? part.raw : ''}
          disabled={scope === null}
          aria-labelledby={labelId}
          aria-invalid={field.invalid === null ? undefined : true}
          aria-describedby={errorId ?? undefined}
          data-focus-key={`${scope ?? 'none'}:${field.path}`}
          onChange={(event) => {
            if (scope !== null && part !== undefined)
              onEdit(scope, part.key, event.currentTarget.value);
          }}
        >
          {field.unlistedEmpty ? <option value="">{t.unlistedEmpty.short}</option> : null}
          {field.unlisted === null || typeof part?.raw !== 'string' ? null : (
            <ServerOption key="unlisted" value={part.raw} label={field.unlisted} />
          )}
          {field.options.map((option) =>
            option.label === null ? null : (
              <ServerOption key={option.value} value={option.value} label={option.label} />
            ),
          )}
        </select>
        {help}
      </div>
    );
  }
  if (field.type === null) {
    return (
      <div className="tp-settings__field" data-field={field.path}>
        <span id={labelId} className="tp-settings__label">
          {label}
        </span>
        <span className="tp-settings__help">{t.unknownType.short}</span>
      </div>
    );
  }
  const pair = field.type === 'range' || field.type === 'point';
  const partLabels: readonly (CopyEntry | null)[] = !pair
    ? [null]
    : field.type === 'range'
      ? [t.low, t.high]
      : [t.x, t.y];
  return (
    <div
      className={`tp-settings__field${pair ? ' tp-settings__field--pair' : ''}`}
      data-field={field.path}
    >
      <span className="tp-settings__label">
        <span id={labelId}>{label}</span>
        {field.unit === null ? null : (
          <span className="tp-settings__unit">
            <ServerValue kind="id" value={field.unit} />
          </span>
        )}
      </span>
      <span className="tp-settings__parts">
        {field.parts.map((part, index) => (
          <PartInput
            key={part.key}
            field={field}
            part={part}
            index={index}
            labelId={labelId}
            partLabel={partLabels[index] ?? null}
            errorId={errorId}
            scope={scope}
            onEdit={onEdit}
          />
        ))}
      </span>
      {field.type === 'string' ? null : (
        <span className="tp-settings__bounds">
          {t.bounds(field.min, field.max)}
          {field.whole ? <span>{t.wholeOnly.short}</span> : null}
        </span>
      )}
      {help}
    </div>
  );
}

/**
 * One typed settings module (collection brief C1 to C4; abilities brief A1): every field
 * the server describes, the raw draft kept as typed with its reason when not valid, one
 * Save with its visible reason when not offered, Discard, and the newest save's line.
 * Field labels, units and descriptions are the server's.
 */
export function SettingsModuleForm({
  vm,
  legend,
  intro,
  advanced,
  notes,
  onEdit,
  onDiscard,
  onSave,
  onDismiss,
}: SettingsModuleFormProps) {
  const own = useId();
  const { save } = vm;
  const command = save.command;
  const inAdvanced = (path: string) => advanced?.paths.includes(path) === true;
  const draw = (field: SettingsFieldVM) => (
    <SettingsField
      key={field.path}
      field={field}
      scope={vm.scope}
      note={notes?.[field.path] ?? null}
      onEdit={onEdit}
    />
  );
  const main = vm.fields.filter((field) => !inAdvanced(field.path));
  const extra = vm.fields.filter((field) => inAdvanced(field.path));
  return (
    <fieldset className="tp-settings tp-tile" data-module={vm.id}>
      <legend id={`${own}-legend`} tabIndex={-1}>
        {legend === undefined ? (
          vm.title === null ? null : (
            <ServerValue kind="name" value={vm.title} />
          )
        ) : (
          legend.short
        )}
      </legend>
      {intro === undefined ? null : (
        <div className="tp-settings__intro">
          <span>{intro.short}</span>
          {intro.why === undefined ? null : <Why why={intro.why} />}
        </div>
      )}
      {vm.description === null ? null : (
        <p className="tp-settings__help">
          <ServerValue kind="message" value={vm.description} />
        </p>
      )}
      {vm.readOnly === null ? null : (
        <div className="tp-settings__read-only" data-read-only={vm.readOnly}>
          <span>{t.readOnly[vm.readOnly].short}</span>
          {t.readOnly[vm.readOnly].why === undefined ? null : (
            <Why why={t.readOnly[vm.readOnly].why ?? t.readOnly[vm.readOnly].short} />
          )}
        </div>
      )}
      <div className="tp-settings__fields">{main.map(draw)}</div>
      {extra.length === 0 || advanced === undefined ? null : (
        <Disclosure label={advanced.label.short}>
          <div className="tp-settings__fields">{extra.map(draw)}</div>
        </Disclosure>
      )}
      {vm.applyNotice === null ? null : (
        <p className="tp-settings__help">
          <ServerValue kind="message" value={vm.applyNotice} />
        </p>
      )}
      {vm.readOnly === null ? (
        <div className="tp-settings__actions">
          {/* F6C-03: one Save element whatever its state, so a focused Save keeps focus. */}
          <span className="tp-settings__action">
            <Button
              tier="secondary"
              label={t.save.short}
              focusKey={`${vm.id}:save`}
              busy={save.sending}
              {...(save.enabled && command !== null
                ? {}
                : { disabled: true as const, reasonId: `${own}-reason` })}
              onClick={() => {
                if (save.enabled && command !== null) onSave(command);
              }}
            />
            {save.enabled && command !== null ? null : (
              <span id={`${own}-reason`} className="tp-reason">
                {reasonOf(save.reason).short}
              </span>
            )}
          </span>
          {vm.dirty && vm.scope !== null ? (
            <Button
              tier="quiet"
              label={t.discard.short}
              focusKey={`${vm.id}:discard`}
              onClick={() => {
                if (vm.scope !== null) onDiscard(vm.scope);
              }}
            />
          ) : null}
          {vm.reconcile !== null && vm.scope !== null ? (
            <Button
              tier="secondary"
              label={t.reconcile.short}
              focusKey={`${vm.id}:reconcile`}
              onClick={() => {
                if (vm.scope !== null && vm.reconcile !== null)
                  onEdit(vm.scope, vm.reconcile.key, vm.reconcile.revision);
              }}
            />
          ) : null}
        </div>
      ) : null}
      {vm.outcome === null ? null : <SaveOutcome outcome={vm.outcome} onDismiss={onDismiss} />}
    </fieldset>
  );
}
