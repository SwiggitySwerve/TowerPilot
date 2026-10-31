import { useId } from 'react';
import { entryDraftMarker } from '../../core/runEntry.ts';
import { copy } from '../../copy/catalogue.ts';
import { selectRunEntry } from '../../store/selectors/runEntry.ts';
import { Button } from '../../ui/Button.tsx';
import { HelpTip } from '../../ui/HelpTip.tsx';
import { ActionRow, Reason } from '../../ui/ActionRow.tsx';
import { Fact, Facts } from '../../ui/Facts.tsx';
import { Tile } from '../../ui/Tile.tsx';
import { ServerOption } from '../../ui/ServerValue.tsx';
import { EditingTargetLine } from '../profiles/EditingTargetLine.tsx';
import { pageHref } from '../../ui/routes.ts';
import { useDashboard, useView } from '../dashboard/context.ts';
import { SaveOutcome } from '../settings/SaveOutcome.tsx';
import './run-entry.css';

const t = copy.runEntry;
type FieldVM = ReturnType<typeof selectRunEntry>['fields'][number];

/** Display groups follow the field owner's order; they do not change save targets. */
const sections = ['identity', 'behavior', 'policies'] as const;
function sectionFor(field: FieldVM): (typeof sections)[number] {
  if (field.key.startsWith('policies.') || field.key === 'shopping') return 'policies';
  return field.key === 'label' || field.key === 'loadout' || field.key === 'tier'
    ? 'identity'
    : 'behavior';
}

/** Reasons that belong to one changed field; the rest are said once, on the group's Save. */
const FIELD_REASONS: ReadonlySet<string> = new Set(['activeOnly', 'revision']);

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
    // A missing optional label is an action requirement until the person types a draft.
    (field.key !== 'label' || field.raw !== '' || field.dirty) &&
    field.reason !== null &&
    !['unchanged', 'pending', 'unknown', 'revision', 'unavailable', 'activeOnly'].includes(
      field.reason,
    );
  const help = field.key === 'perk_bans' ? t.perks : field.key === 'max_wave' ? t.cap : null;
  // How a quest value is read is background, not state: it opens from the field's help icon.
  const tip = field.key === 'rides' || field.key === 'cycles' ? t.questValue : null;
  const label = t.fields[field.key];
  return (
    <fieldset
      className="tp-run-entry__field"
      data-entry-field={field.key}
      disabled={field.readOnly}
    >
      <legend tabIndex={-1} className={field.type === 'toggle' ? 'tp-visually-hidden' : undefined}>
        {label.short}
      </legend>
      {field.type === 'toggle' ? (
        // A check box reads like every other one on the page: the box, then its name.
        <label className="tp-check-field">
          <input
            id={inputId}
            type="checkbox"
            checked={field.raw === true}
            onChange={(event) => {
              edit(event.currentTarget.checked);
            }}
          />
          <span>{label.short}</span>
        </label>
      ) : (
        <>
          <label htmlFor={inputId} className="tp-visually-hidden">
            {label.short}
          </label>
          {field.type === 'select' ? (
            <select
              className="tp-field-control"
              id={inputId}
              value={typeof field.raw === 'string' ? field.raw : ''}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? reasonId : undefined}
              onChange={(event) => {
                edit(event.currentTarget.value);
              }}
            >
              {field.none ? (
                <option value="">{(field.key === 'dissonant_tab' ? t.coin : t.none).short}</option>
              ) : null}
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
              className="tp-field-control"
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
            <div className="tp-run-entry__input">
              <input
                className="tp-field-control"
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
              {tip === null ? null : <HelpTip label={label.short}>{tip.short}</HelpTip>}
            </div>
          )}
        </>
      )}
      {invalid && field.reason !== null ? (
        <p id={reasonId} className="tp-run-entry__error" role="alert">
          {t.reasons[field.reason].short}
        </p>
      ) : null}
      {help === null ? null : (
        <div id={helpId} className="tp-run-entry__hint">
          {help.short}
        </div>
      )}
      {field.key !== 'perk_bans' ? null : (
        <label className="tp-run-entry__remove tp-check-field">
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
              : pageHref('abilities', field.policyEditor)
          }
        >
          {(field.key === 'policies.gather' ? t.gather : t.abilities).short}
        </a>
      )}
      {field.needsChainLightning ? <div>{t.chainLightning.short}</div> : null}
      {/* A field's own state: why it cannot save now, said once, beside the field. */}
      {!invalid && field.reason !== null && FIELD_REASONS.has(field.reason) && field.dirty ? (
        <p id={reasonId} className="tp-run-entry__hint">
          {t.reasons[field.reason].short}
        </p>
      ) : null}
      {/* Clear (or the quest default) is offered while there is something to clear. */}
      {(field.key === 'label' || field.key === 'rides') && field.clearReason !== 'unchanged' ? (
        <div className="tp-run-entry__actions">
          <ActionRow
            reason={
              field.clearReason === null ? null : (
                <Reason id={`${uid}-clear-reason`} entry={t.reasons[field.clearReason]} />
              )
            }
          >
            <Button
              tier="quiet"
              label={(field.key === 'label' ? t.clearLabel : t.questDefault).short}
              {...(field.clearCommand === null
                ? {
                    disabled: true,
                    reasonId: `${uid}-clear-reason`,
                  }
                : {})}
              onClick={() => {
                if (field.clearCommand !== null) void commands.patchRunEntry(field.clearCommand);
              }}
            />
          </ActionRow>
        </div>
      ) : null}
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

/** Reasons the bar says once for the group (one changed field's own reasons sit beside it). */
function groupReason(reason: FieldVM['reason']): reason is 'pending' | 'unknown' | 'unavailable' {
  return reason === 'pending' || reason === 'unknown' || reason === 'unavailable';
}

/**
 * One Save and one Discard for a group of fields. Save sends each changed field as its own
 * profile patch, chained on the revision the previous one answered (commands.saveRunEntryGroup).
 */
function GroupBar({
  section,
  fields,
}: {
  readonly section: (typeof sections)[number];
  readonly fields: readonly FieldVM[];
}) {
  const { commands } = useDashboard();
  const uid = useId();
  const reasonId = `${uid}-reason`;
  // A read-only group (the last read failed) keeps its drafts and offers no action on them.
  const readOnly = fields.some((field) => field.readOnly);
  const changed = fields.filter((field) => field.dirty && field.reason !== 'unchanged');
  const blocked = changed.find((field) => field.command === null);
  const group = blocked?.reason ?? null;
  const reason = readOnly
    ? t.reasons.unavailable
    : changed.length === 0
      ? t.reasons.unchanged
      : groupReason(group)
        ? t.reasons[group]
        : blocked === undefined
          ? null
          : t.fixFields;
  const send = changed.flatMap((field) => (field.command === null ? [] : [field.command]));
  return (
    <div className="tp-run-entry__bar" data-entry-bar={section}>
      <ActionRow reason={reason === null ? null : <Reason id={reasonId} entry={reason} />}>
        <Button
          tier="secondary"
          label={t.saveGroup[section].short}
          focusKey={`entry:${section}:save`}
          {...(reason === null ? {} : { disabled: true, reasonId })}
          onClick={() => {
            if (reason === null) void commands.saveRunEntryGroup(send);
          }}
        />
        {fields.some((field) => field.dirty) ? (
          <Button
            tier="quiet"
            label={t.discardGroup.short}
            {...(readOnly ? { disabled: true, reasonId } : {})}
            onClick={() => {
              if (readOnly) return;
              for (const field of fields) if (field.dirty) commands.discardDraft(field.scope);
            }}
          />
        ) : null}
        {changed.length === 0 ? null : (
          <span className="tp-run-editor__count">{copy.runs.changes(changed.length)}</span>
        )}
      </ActionRow>
    </div>
  );
}

/** Saved entry only: the existing routine editor and live battle remain separate. */
export function RunEntry() {
  const vm = useView(selectRunEntry);
  const { commands } = useDashboard();
  return (
    <div data-run-entry="true">
      <Tile
        className="tp-run-entry"
        titleId="run-entry-title"
        title={t.title.short}
        intro={t.scope}
      >
        <div className="tp-run-entry__head">
          <EditingTargetLine />
          <div data-entry-statistics="true">
            <Facts layout="inline">
              <Fact label={copy.runs.statistics.short} value={copy.runs.alwaysOn.short} />
            </Facts>
          </div>
        </div>
        <div className="tp-control-row">
          <label className="tp-runs__picker-label">
            <span>{t.picker.short}</span>
            <select
              className="tp-field-control"
              value={vm.run ?? ''}
              onChange={(event) => {
                commands.openRuns(true, event.currentTarget.value);
              }}
            >
              {vm.unlistedRun === null ? null : (
                <ServerOption value={vm.run ?? ''} label={vm.unlistedRun} />
              )}
              {vm.runs.map((run) =>
                run.label === null ? null : (
                  <ServerOption key={run.key} value={run.key} label={run.label} />
                ),
              )}
            </select>
          </label>
          <Button tier="quiet" label={t.check.short} onClick={commands.checkRunEntry} />
        </div>
        {!vm.readable || vm.fields.length === 0 ? <p>{t.unavailable.short}</p> : null}
        {vm.readFailure === null ? null : (
          <div role="status">
            <p>{t.readFailed.short}</p>
            <p>
              {vm.readFailure.network ? copy.runtime.network.short : copy.runtime.unavailable.short}
            </p>
          </div>
        )}
        {vm.notSent ? <div role="status">{t.notSent.short}</div> : null}
        {sections.map((section) => {
          const fields = vm.fields.filter((field) => sectionFor(field) === section);
          return fields.length === 0 ? null : (
            <div key={section} data-entry-section={section}>
              <Tile
                titleId={`run-entry-${section}`}
                title={copy.runs.entrySections[section].short}
                level={4}
              >
                <div className="tp-run-entry__grid">
                  {fields.map((field) => (
                    <EntryField key={field.scope} field={field} />
                  ))}
                </div>
                <GroupBar section={section} fields={fields} />
              </Tile>
            </div>
          );
        })}
      </Tile>
    </div>
  );
}
