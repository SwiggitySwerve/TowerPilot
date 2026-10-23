import { useId } from 'react';
import { entryDraftMarker } from '../../core/runEntry.ts';
import { copy } from '../../copy/catalogue.ts';
import { selectRunEntry } from '../../store/selectors/runEntry.ts';
import { Button } from '../../ui/Button.tsx';
import { ServerOption } from '../../ui/ServerValue.tsx';
import { pageHref } from '../../ui/routes.ts';
import { useDashboard, useView } from '../dashboard/context.ts';
import { SaveOutcome } from '../settings/SaveOutcome.tsx';
import './run-entry.css';

const t = copy.runEntry;
type FieldVM = ReturnType<typeof selectRunEntry>['fields'][number];

function EntryField({ field }: { readonly field: FieldVM }) {
  const { commands } = useDashboard();
  const uid = useId();
  const inputId = `${uid}-input`;
  const reasonId = `${uid}-reason`;
  const helpId = `${uid}-help`;
  const edit = (value: string | boolean) => {
    commands.editDraft(
      field.scope,
      'base_revision',
      entryDraftMarker(field.baseRevision, value, field.remove),
    );
    commands.editDraft(field.scope, 'value', value);
  };
  const invalid =
    field.reason !== null &&
    !['unchanged', 'pending', 'unknown', 'revision', 'unavailable'].includes(field.reason);
  const help = field.key === 'perk_bans' ? t.perks : field.key === 'max_wave' ? t.cap : null;
  const label = t.fields[field.key];
  return (
    <fieldset className="tp-run-entry__field" data-entry-field={field.key}>
      <legend tabIndex={-1}>{label.short}</legend>
      <label htmlFor={inputId} className="tp-visually-hidden">
        {label.short}
      </label>
      {field.type === 'toggle' ? (
        <input
          id={inputId}
          type="checkbox"
          checked={field.raw === true}
          onChange={(event) => {
            edit(event.currentTarget.checked);
          }}
        />
      ) : field.type === 'select' ? (
        <select
          id={inputId}
          value={typeof field.raw === 'string' ? field.raw : ''}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? reasonId : undefined}
          onChange={(event) => {
            edit(event.currentTarget.value);
          }}
        >
          {field.none ? <option value="">{t.none.short}</option> : null}
          {field.unlisted === null ? null : (
            <ServerOption
              value={typeof field.raw === 'string' ? field.raw : ''}
              label={field.unlisted}
            />
          )}
          {field.choices.map((choice) =>
            choice.label === null ? null : (
              <ServerOption key={choice.value} value={choice.value} label={choice.label} />
            ),
          )}
        </select>
      ) : field.type === 'list' ? (
        <textarea
          id={inputId}
          value={typeof field.raw === 'string' ? field.raw : ''}
          rows={3}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${helpId} ${reasonId}` : helpId}
          onChange={(event) => {
            edit(event.currentTarget.value);
          }}
        />
      ) : (
        <input
          id={inputId}
          type="text"
          inputMode={field.type === 'number' ? 'numeric' : undefined}
          value={typeof field.raw === 'string' ? field.raw : ''}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? reasonId : help === null ? undefined : helpId}
          onChange={(event) => {
            edit(event.currentTarget.value);
          }}
        />
      )}
      {help === null ? null : <div id={helpId}>{help.short}</div>}
      {field.key !== 'perk_bans' ? null : (
        <label className="tp-run-entry__remove">
          <input
            type="checkbox"
            checked={field.remove}
            onChange={(event) => {
              commands.editDraft(
                field.scope,
                'base_revision',
                entryDraftMarker(field.baseRevision, field.raw, event.currentTarget.checked),
              );
              commands.editDraft(field.scope, 'remove', event.currentTarget.checked);
            }}
          />
          <span>{t.remove.short}</span>
        </label>
      )}
      {field.policyEditor === null ? null : (
        <a
          href={
            field.policyEditor.kind === 'gather'
              ? pageHref('collection', { kind: 'policy', policy: field.policyEditor.id })
              : pageHref('abilities')
          }
        >
          {(field.key === 'policies.gather' ? t.gather : t.abilities).short}
        </a>
      )}
      <div className="tp-run-entry__actions">
        <Button
          tier="secondary"
          label={t.save.short}
          focusKey={`entry:${field.scope}:save`}
          {...(field.command === null ? { disabled: true, reasonId } : {})}
          onClick={() => {
            if (field.command !== null) void commands.patchProfile(field.command);
          }}
        />
        {field.dirty ? (
          <Button
            tier="quiet"
            label={t.discard.short}
            onClick={() => {
              commands.discardDraft(field.scope);
            }}
          />
        ) : null}
      </div>
      {field.reason === null ? null : <div id={reasonId}>{t.reasons[field.reason].short}</div>}
      {field.continuation === null ? null : (
        <Button
          tier="quiet"
          label={t.continue.short}
          onClick={() => {
            const next = field.continuation;
            if (next === null) return;
            for (const intent of next.ids) commands.acceptCurrent(intent);
            commands.editDraft(
              field.scope,
              'base_revision',
              entryDraftMarker(next.revision, field.raw, field.remove),
            );
            commands.editDraft(field.scope, 'continued_after', next.after);
          }}
        />
      )}
      {field.outcome === null ? null : (
        <SaveOutcome outcome={field.outcome} onDismiss={commands.dismiss} />
      )}
      {field.profiles ? <a href={pageHref('profiles')}>{t.profiles.short}</a> : null}
    </fieldset>
  );
}

/** Saved entry only: the existing routine editor and live battle remain separate. */
export function RunEntry() {
  const vm = useView(selectRunEntry);
  const { commands } = useDashboard();
  return (
    <section className="tp-run-entry" data-run-entry="true" aria-labelledby="run-entry-title">
      <h3 id="run-entry-title">{t.title.short}</h3>
      <p>{t.scope.short}</p>
      <Button tier="quiet" label={t.check.short} onClick={commands.checkCollection} />
      {!vm.readable || vm.fields.length === 0 ? <p>{t.unavailable.short}</p> : null}
      {vm.notSent ? <div role="status">{t.notSent.short}</div> : null}
      <div className="tp-run-entry__grid">
        {vm.fields.map((field) => (
          <EntryField key={field.scope} field={field} />
        ))}
      </div>
    </section>
  );
}
