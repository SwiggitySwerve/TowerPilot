import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { equipment as t } from '../../copy/equipment.ts';
import { configEquipment as c } from '../../copy/configEquipment.ts';
import { type EquipmentStore } from '../../store/equipment.ts';
import { selectEquipment, selectTournamentSettings } from '../../store/selectors/equipment.ts';
import { useDashboard, useView, useEpochKey } from '../dashboard/context.ts';
import { SettingsModuleForm } from '../settings/SettingsModuleForm.tsx';
import { Button } from '../../ui/Button.tsx';
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx';
import { ServerOption, ServerValue } from '../../ui/ServerValue.tsx';
import { pageHref } from '../../ui/routes.ts';
import { TopBar } from '../dashboard/topBar/TopBar.tsx';
import './equipment.css';

function TournamentSettings() {
  const vm = useView(selectTournamentSettings);
  const { commands } = useDashboard();
  const epoch = useEpochKey();
  useEffect(() => {
    commands.openEquipment(true);
    commands.checkSettings();
    return () => {
      commands.openEquipment(false);
    };
  }, [commands, epoch]);
  return (
    <section aria-labelledby="equipment-tournament">
      <h2 id="equipment-tournament">{c.tournament.short}</h2>
      <p>
        {vm.account === null ? (
          c.legacy.short
        ) : (
          <ServerValue kind="name" value={vm.account} label={c.account.short} />
        )}
      </p>
      <Button tier="quiet" label={c.check.short} onClick={commands.checkSettings} />
      {vm.failed ? <p role="alert">{c.stale.short}</p> : null}
      {vm.module === null ? (
        <p>{c.unavailable.short}</p>
      ) : (
        <SettingsModuleForm
          vm={vm.module}
          intro={c.tournamentIntro}
          onEdit={commands.editDraft}
          onDiscard={commands.discardDraft}
          onSave={(command) => {
            void commands.saveSettings(command);
          }}
          onDismiss={commands.dismiss}
        />
      )}
    </section>
  );
}

export function EquipmentPage({ equipment }: { readonly equipment: EquipmentStore }) {
  const state = useSyncExternalStore(equipment.subscribe, equipment.getSnapshot);
  const [now, setNow] = useState(Date.now);
  const [discard, setDiscard] = useState<{
    key: string | null;
    epoch: number;
    name: string | null;
    version: number;
  } | null>(null);
  const vm = selectEquipment(state, now);
  const e = vm.entry;
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  useLayoutEffect(() => {
    const current = selectEquipment(equipment.getSnapshot(), Date.now());
    if (current.entry?.focus != null) document.getElementById(current.entry.focus)?.focus();
  }, [equipment, state.key, vm.selected]);
  return (
    <>
      <header className="tp-topbar">
        <TopBar pageId="equipment" title={t.pageName.short} readOnly />
      </header>
      <main
        id="main"
        className="tp-main tp-equipment"
        tabIndex={-1}
        onFocusCapture={(event) => {
          if (event.target instanceof HTMLElement && event.target.id.startsWith('equipment:'))
            equipment.rememberFocus(event.target.id);
        }}
      >
        <p>{t.intro.short}</p>
        <TournamentSettings />
        <div className="tp-equipment__target">
          <strong>{t.target.short}</strong>
          {vm.instance === null ? t.unknown.short : <ServerValue kind="name" value={vm.instance} />}
          {vm.account === null ? t.unknown.short : <ServerValue kind="name" value={vm.account} />}
          {vm.profile === null ? t.unknown.short : <ServerValue kind="name" value={vm.profile} />}
        </div>
        <div className="tp-equipment__read">
          <button
            id="equipment:read"
            className="tp-button"
            type="button"
            disabled={vm.target?.busy === true || state.context === null}
            onClick={() => {
              void equipment.refresh();
            }}
          >
            {t.read.short}
          </button>
          {vm.target?.busy === true ? <p role="status">{t.reading.short}</p> : null}
        </div>
        {state.context?.profile == null ? <p>{t.noTarget.short}</p> : null}
        {vm.target?.readError === true ? <p role="alert">{t.readError.short}</p> : null}
        {vm.stale ? <p role="status">{t.stale.short}</p> : null}
        {vm.target?.config !== undefined && vm.rows.length === 0 ? <p>{t.empty.short}</p> : null}
        <details className="tp-equipment__help">
          <summary id="equipment:help">{t.help.short}</summary>
          <p>{t.helpGlobal.short}</p>
          <p>{t.helpNone.short}</p>
          <p>{t.helpManual.short}</p>
          <p>{t.limit.short}</p>
        </details>
        <div className="tp-equipment__layout">
          <section aria-labelledby="equipment-list">
            <h2 id="equipment-list">{t.list.short}</h2>
            <ul className="tp-equipment__list">
              {vm.rows.map((row) => (
                <li
                  key={row.key}
                  className="tp-equipment__card"
                  data-selected={row.key === vm.selected}
                >
                  <button
                    className="tp-button"
                    id={`equipment:select:${encodeURIComponent(row.key)}`}
                    type="button"
                    aria-pressed={row.key === vm.selected}
                    onClick={() => {
                      equipment.select(row.key);
                    }}
                  >
                    <ServerValue kind="name" value={row.label} />
                  </button>
                  <p>{t[row.summary].short}</p>
                  {row.selections.map((selection) => (
                    <p key={selection.field}>
                      <strong>{t[selection.field].short}</strong>
                      <ServerValue kind="name" value={selection.value} />
                    </p>
                  ))}
                  {row.consumers.length > 0 ? <p>{t.consumers.short}</p> : <p>{t.unused.short}</p>}
                  <div className="tp-equipment__consumers">
                    {row.consumers.map((consumer) => (
                      <a
                        id={`equipment:run:${encodeURIComponent(row.key)}:${encodeURIComponent(consumer.key)}`}
                        key={consumer.key}
                        href={pageHref('runs', { kind: 'saved', run: consumer.key })}
                      >
                        <ServerValue kind="name" value={consumer.label} />
                      </a>
                    ))}
                  </div>
                  {row.dirty ? <strong>{t.dirty.short}</strong> : null}
                  {row.missing ? (
                    <p>
                      <span>{t.missing.short}</span>
                      {t.space}
                      <a href="#recognition">{t.recognition.short}</a>
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
          {e !== null ? (
            <section aria-labelledby="equipment-editor" className="tp-equipment__editor">
              <h2 id="equipment-editor">
                {t.editor.short}
                {t.space}
                {vm.name === null ? null : <ServerValue kind="name" value={vm.name} />}
              </h2>
              <p>{t.scope.short}</p>
              {vm.missingTarget ? <p role="alert">{t.missingTarget.short}</p> : null}
              <div className="tp-equipment__revisions">
                <p>
                  {t.revision.short}
                  {t.space}
                  {vm.revision === null ? (
                    t.unknown.short
                  ) : (
                    <ServerValue kind="id" value={vm.revision} />
                  )}
                </p>
                <p>
                  {t.base.short}
                  {t.space}
                  {vm.base === null ? t.unknown.short : <ServerValue kind="id" value={vm.base} />}
                </p>
              </div>
              <div className="tp-equipment__save">
                <strong>
                  {vm.name === null ? null : <ServerValue kind="name" value={vm.name} />}
                  {t.space}
                  {e.dirty ? t.dirty.short : t.clean.short}
                </strong>
                <Button
                  id="equipment:save"
                  tier="secondary"
                  label={t.save.short}
                  busy={e.outcome === 'checking' || e.outcome === 'sending'}
                  {...(!vm.canSave ? { disabled: true, reasonId: 'equipment:blocked' } : {})}
                  onClick={equipment.save}
                />
                <Button
                  id="equipment:cancel"
                  tier="quiet"
                  label={t.cancel.short}
                  {...(!e.dirty || vm.pending
                    ? { disabled: true, reasonId: 'equipment:blocked' }
                    : {})}
                  onClick={() => {
                    setDiscard({
                      key: state.key,
                      epoch: state.epoch,
                      name: vm.selected,
                      version: e.version,
                    });
                  }}
                />
                {e.outcome === null ? null : (
                  <p role="status">
                    {t[e.outcome === 'unknown' ? 'unknownResult' : e.outcome].short}
                  </p>
                )}
              </div>
              {vm.refusalContext === null ? null : (
                <div className="tp-equipment__result">
                  <strong>{t.currentContext.short}</strong>
                  <pre>
                    <ServerValue kind="detail" value={vm.refusalContext} />
                  </pre>
                </div>
              )}
              {!vm.canSave ? (
                <p id="equipment:blocked">
                  {vm.restore.blocked === null
                    ? vm.restore.invalid
                      ? c.invalid.short
                      : t.blocked.short
                    : c[vm.restore.blocked].short}
                </p>
              ) : null}
              {vm.manual ? <p className="tp-equipment__warning">{t.manualWarning.short}</p> : null}
              <label>
                <span>{t.mode.short}</span>
                <select
                  id="equipment:mode"
                  value={e.draft.mode}
                  onChange={(event) => {
                    const mode = event.currentTarget.value;
                    if (mode === 'global' || mode === 'category' || mode === 'manual')
                      equipment.mode(mode);
                  }}
                >
                  {vm.manual ? <option value="manual">{t.manual.short}</option> : null}
                  <option value="global">{t.global.short}</option>
                  <option value="category">{t.category.short}</option>
                </select>
              </label>
              <div className="tp-equipment__fields">
                {vm.fields.map((field) => (
                  <label key={field.key}>
                    <span>{t[field.key].short}</span>
                    <select
                      id={`equipment:${field.key}`}
                      value={field.value}
                      aria-invalid={field.invalid || undefined}
                      aria-describedby={field.invalid ? 'equipment:missing' : undefined}
                      onChange={(event) => {
                        equipment.edit(field.key, event.currentTarget.value);
                      }}
                    >
                      <option value="">
                        {field.key === 'global_preset' ? t.chooseGlobal.short : t.none.short}
                      </option>
                      {field.missingOption === null ? null : (
                        <ServerOption value={field.value} label={field.missingOption} />
                      )}
                      {field.options.map((option) => (
                        <ServerOption
                          key={option.value}
                          value={option.value}
                          label={option.label}
                        />
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              {vm.fields.some((field) => field.invalid) ? (
                <p id="equipment:missing" role="alert">
                  {t.missing.short}
                  {t.space}
                  <a id="equipment:recognition" href="#recognition">
                    {t.recognition.short}
                  </a>
                </p>
              ) : null}
              {vm.emptyBody && e.draft.mode !== 'manual' ? <p>{t.noChoice.short}</p> : null}
              <section aria-labelledby="equipment-restore">
                <h3 id="equipment-restore">{c.restore.short}</h3>
                <p>{c.restoreIntro.short}</p>
                {vm.restore.usage === null ? null : <p>{c[vm.restore.usage].short}</p>}
                <label>
                  <span>{c.cards.short}</span>
                  <select
                    id="equipment:restore-cards"
                    value={vm.restore.cards}
                    onChange={(event) => {
                      equipment.editRestoreCards(event.currentTarget.value);
                    }}
                  >
                    <option value="">{t.none.short}</option>
                    {vm.restore.missing === null ? null : (
                      <ServerOption value={vm.restore.cards} label={vm.restore.missing} />
                    )}
                    {vm.restore.choices.map((choice) => (
                      <ServerOption key={choice.value} value={choice.value} label={choice.label} />
                    ))}
                  </select>
                </label>
                {vm.restore.missing === null ? null : <p>{c.missingCards.short}</p>}
                <h4>{c.modules.short}</h4>
                {vm.restore.rows.map((row, index) => (
                  <fieldset key={row.key} className="tp-equipment__restore-row">
                    <legend id={`restore-row-${row.key}`}>{c.entry(index)}</legend>
                    <label>
                      <span>{c.module.short}</span>
                      <input
                        type="text"
                        value={row.module}
                        aria-invalid={row.invalid || undefined}
                        aria-describedby={row.invalid ? `restore-error-${row.key}` : undefined}
                        aria-labelledby={`restore-module-${row.key} restore-row-${row.key}`}
                        onChange={(event) => {
                          equipment.editRestoreModule(row.key, 'module', event.currentTarget.value);
                        }}
                      />
                      <span id={`restore-module-${row.key}`} hidden>
                        {c.module.short}
                      </span>
                    </label>
                    <label>
                      <span>{c.slot.short}</span>
                      <input
                        type="text"
                        value={row.slot}
                        aria-invalid={row.invalid || undefined}
                        aria-describedby={row.invalid ? `restore-error-${row.key}` : undefined}
                        aria-labelledby={`restore-slot-${row.key} restore-row-${row.key}`}
                        onChange={(event) => {
                          equipment.editRestoreModule(row.key, 'slot', event.currentTarget.value);
                        }}
                      />
                      <span id={`restore-slot-${row.key}`} hidden>
                        {c.slot.short}
                      </span>
                    </label>
                    <button
                      className="tp-button"
                      type="button"
                      aria-labelledby={`restore-remove-${row.key} restore-row-${row.key} restore-name-${row.key}`}
                      onClick={() => {
                        equipment.removeRestoreModule(row.key);
                      }}
                    >
                      <span id={`restore-remove-${row.key}`}>{c.removeModule.short}</span>
                    </button>
                    <span id={`restore-name-${row.key}`} hidden>
                      {row.name === null ? null : <ServerValue kind="name" value={row.name} />}
                    </span>
                    {row.invalid ? (
                      <p id={`restore-error-${row.key}`} role="alert">
                        {c.invalid.short}
                      </p>
                    ) : null}
                    {row.raw === null ? null : (
                      <pre>
                        <ServerValue kind="detail" value={row.raw} />
                      </pre>
                    )}
                  </fieldset>
                ))}
                <button className="tp-button" type="button" onClick={equipment.addRestoreModule}>
                  {c.addModule.short}
                </button>
                {vm.restore.invalid ? <p role="alert">{c.invalid.short}</p> : null}
              </section>
              <details className="tp-equipment__compare" open={vm.conversion || undefined}>
                <summary id="equipment:compare">{t.compare.short}</summary>
                <h3>{t.before.short}</h3>
                <pre>
                  {vm.before === null ? null : <ServerValue kind="detail" value={vm.before} />}
                </pre>
                {vm.reconcile ? (
                  <>
                    <h3>{t.latest.short}</h3>
                    <pre>
                      {vm.latest === null ? null : <ServerValue kind="detail" value={vm.latest} />}
                    </pre>
                  </>
                ) : null}
                <h3>{t.after.short}</h3>
                <pre>
                  {vm.after === null ? null : <ServerValue kind="detail" value={vm.after} />}
                </pre>
                {vm.removed.length > 0 ? (
                  <>
                    <h3>{t.removed.short}</h3>
                    <ul>
                      {vm.removed.map((name) => (
                        <li key={name}>
                          <ServerValue kind="name" value={name} />
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {vm.conversion ? (
                  <label className="tp-equipment__review">
                    <input
                      id="equipment:conversion"
                      type="checkbox"
                      checked={vm.conversionReviewed}
                      onChange={(event) => {
                        equipment.approveConversion(event.currentTarget.checked);
                      }}
                    />
                    <span>{t.reviewConversion.short}</span>
                  </label>
                ) : null}
              </details>
              {vm.conversion && !vm.conversionReviewed ? <p>{t.conversionNeeded.short}</p> : null}
              <section
                aria-label={t.result.short}
                role={e.outcome === 'refused' || e.outcome === 'conflict' ? 'alert' : 'status'}
                className="tp-equipment__result"
              >
                {vm.resultRevision === null ? null : (
                  <ServerValue kind="id" value={vm.resultRevision} label={t.revision.short} />
                )}
                {vm.errors.map((error, i) => (
                  <p key={i}>
                    <ServerValue kind="message" value={error} />
                  </p>
                ))}
              </section>
              {vm.warnings.length === 0 ? null : (
                <section aria-label={t.warnings.short} className="tp-equipment__warning">
                  <h3>{t.warnings.short}</h3>
                  {vm.validationFromEarlierRead ? <p>{t.earlierValidation.short}</p> : null}
                  {vm.warnings.map((warning, i) => (
                    <p key={i}>
                      <ServerValue kind="message" value={warning} />
                    </p>
                  ))}
                </section>
              )}
              {vm.reconcile ? (
                <div className="tp-equipment__warning">
                  <p>{t.reconcileHelp.short}</p>
                  <button
                    type="button"
                    className="tp-button"
                    disabled={
                      !e.checked ||
                      vm.target?.busy === true ||
                      vm.target?.readError === true ||
                      e.outcome === 'sending'
                    }
                    onClick={equipment.reconcile}
                  >
                    {t.reconcile.short}
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
        <ConfirmDialog
          open={
            discard !== null &&
            discard.key === state.key &&
            discard.epoch === state.epoch &&
            discard.name === vm.selected &&
            discard.version === e?.version
          }
          title={t.cancelTitle.short}
          body={t.cancelBody.short}
          confirmLabel={t.cancel.short}
          cancelLabel={t.keep.short}
          tier="primary"
          onCancel={() => {
            setDiscard(null);
          }}
          onConfirm={() => {
            if (
              discard?.key === state.key &&
              discard.epoch === state.epoch &&
              discard.name === vm.selected &&
              discard.version === e?.version
            )
              equipment.cancel();
            setDiscard(null);
          }}
        />
      </main>
    </>
  );
}
