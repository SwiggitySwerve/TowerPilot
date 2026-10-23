import type { CopyEntry } from '../../copy/text.ts';
import { copy } from '../../copy/catalogue.ts';
import {
  draftChanges,
  includeUpgrade,
  leaveOutUpgrade,
  moveUpgrade,
  reviewQueue,
  setExcluded,
  type QueueDraft,
} from '../../core/shoppingPlan.ts';
import { selectShoppingSaved } from '../../store/selectors/shoppingSaved.ts';
import { Button } from '../../ui/Button.tsx';
import { ServerValue } from '../../ui/ServerValue.tsx';
import { useDashboard, useView } from '../dashboard/context.ts';
import { QueueEditor } from '../shopping/QueueEditor.tsx';
import { QueueRefusal } from '../shopping/QueueRefusal.tsx';
import './savedShopping.css';

const t = copy.shoppingSaved;

type ReviewedConversion = NonNullable<ReturnType<typeof selectShoppingSaved>['conversion']>;

function ReviewNumber({
  label,
  value,
  blank,
}: {
  readonly label: CopyEntry;
  readonly value: number | null;
  readonly blank: CopyEntry;
}) {
  return (
    <div>
      <dt>{label.short}</dt>
      <dd>{value ?? blank.short}</dd>
    </div>
  );
}

function ConversionValues({ value }: { readonly value: ReviewedConversion }) {
  return (
    <div className="tp-saved-shopping__review">
      <dl>
        <div>
          <dt>{t.master.short}</dt>
          <dd>{value.enabled ? t.enabled.short : t.disabled.short}</dd>
        </div>
        <ReviewNumber label={copy.shopping.reserve} value={value.reserve} blank={t.reserveUnset} />
        <ReviewNumber label={t.interval} value={value.interval} blank={t.serverDefault} />
        <div>
          <dt>{copy.shopping.mode.short}</dt>
          <dd>
            {value.mode?.known != null ? (
              copy.shopping.modes[value.mode.known].short
            ) : value.mode?.server == null ? null : (
              <ServerValue kind="name" value={value.mode.server} />
            )}
          </dd>
        </div>
        <div>
          <dt>{copy.shopping.cadence.short}</dt>
          <dd>
            {value.cadence?.known != null ? (
              copy.shopping.cadences[value.cadence.known].short
            ) : value.cadence?.server == null ? null : (
              <ServerValue kind="name" value={value.cadence.server} />
            )}
          </dd>
        </div>
      </dl>
      <h5>{copy.shopping.queue.short}</h5>
      <ol>
        {value.entries.map((entry) => (
          <li key={entry.id} data-conversion-entry={entry.id}>
            <strong>
              {entry.label === null ? null : <ServerValue kind="name" value={entry.label} />}
            </strong>
            <p>{entry.enabled ? copy.shopping.included.short : t.leftOut.short}</p>
            <dl>
              <ReviewNumber label={copy.shopping.tapLimit} value={entry.cap} blank={t.unlimited} />
              <ReviewNumber
                label={copy.shopping.weight}
                value={entry.weight}
                blank={t.serverDefault}
              />
              <ReviewNumber
                label={copy.shopping.fromWave}
                value={entry.from}
                blank={t.serverDefault}
              />
              <ReviewNumber
                label={copy.shopping.untilWave}
                value={entry.until}
                blank={t.noLastWave}
              />
            </dl>
          </li>
        ))}
      </ol>
      <h5>{t.excluded.short}</h5>
      {value.excluded.length === 0 ? (
        <p>{t.noExclusions.short}</p>
      ) : (
        <ul>
          {value.excluded.map((item) => (
            <li key={item.id}>
              {item.label === null ? null : <ServerValue kind="name" value={item.label} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** SQ1–SQ7, SQ11–SQ12: the saved run's queue and its separate Save/Discard row. */
export function SavedShopping() {
  const vm = useView(selectShoppingSaved);
  const { commands } = useDashboard();
  const stage = (next: QueueDraft) => {
    if (vm.scope === null) return;
    for (const [key, value] of draftChanges(vm.draft, next))
      commands.editDraft(vm.scope, key, value);
  };
  if (vm.scope === null) return null;
  const idBase = 'saved-shopping';
  const reason = vm.save.reason;
  const reasons: Readonly<Record<string, CopyEntry>> = copy.runs.reasons;
  const reasonCopy =
    reason === 'invalid_value'
      ? t.invalid
      : reason === 'no_changes'
        ? t.unchanged
        : reason === 'shopping_interval_unknown'
          ? t.intervalUnknown
          : reason !== null && Object.hasOwn(reasons, reason)
            ? reasons[reason]
            : t.unavailable;
  return (
    <section className="tp-saved-shopping" data-shopping-saved aria-labelledby={`${idBase}:title`}>
      <h3 id={`${idBase}:title`}>{t.title.short}</h3>
      <p>{t.scope.short}</p>
      <p>{t.routines.short}</p>
      {!vm.contextReady ? (
        <p role="status">{copy.runs.reasons.context_unknown.short}</p>
      ) : !vm.scopeReady ? (
        <p role="status">
          {
            (vm.catalogueUnavailable
              ? copy.runs.saved.catalogueUnavailable
              : copy.runs.saved.reading
            ).short
          }
        </p>
      ) : !vm.displayAvailable ? (
        <p>{t.unavailable.short}</p>
      ) : !vm.supported ? (
        <p>{t.unsupported.short}</p>
      ) : (
        // F6-12-C-05: the saved queue folds like the live one, with its own scope and Save row.
        <details open className="tp-saved-shopping__details">
          <summary>{t.edit.short}</summary>
          {vm.available ? null : <p role="status">{t.unavailable.short}</p>}
          {vm.showEditor ? (
            <QueueEditor
              vm={vm.editor}
              idBase={idBase}
              onEdit={(key, value) => {
                stage({ ...vm.draft, [key]: value });
              }}
              onInclude={(upgrade) => {
                stage(includeUpgrade(vm.base, vm.draft, upgrade));
              }}
              onLeaveOut={(upgrade) => {
                stage(leaveOutUpgrade(vm.draft, upgrade));
              }}
              onExclude={(upgrade, excluded) => {
                stage(setExcluded(vm.draft, upgrade, excluded));
              }}
              onMove={(upgrade, step) => {
                const next = moveUpgrade(vm.base, vm.draft, upgrade, step);
                if (next === null) return null;
                stage(next);
                return (
                  reviewQueue(vm.base, next).entries.find((entry) => entry.id === upgrade)
                    ?.position ?? null
                );
              }}
            />
          ) : vm.conversion === null ? (
            <>
              <p>{t.createHint.short}</p>
              <Button
                tier="secondary"
                label={t.create.short}
                onClick={() => {
                  stage(vm.create);
                }}
              />
            </>
          ) : (
            <div data-shopping-conversion>
              <h4>{t.conversion.short}</h4>
              <p>{t.conversionWarning.short}</p>
              <ul>
                {vm.conversion.warnings.map((warning, index) =>
                  warning === null ? null : (
                    <li key={index}>
                      <ServerValue kind="message" value={warning} />
                    </li>
                  ),
                )}
              </ul>
              <ConversionValues value={vm.conversion} />
              <div className="tp-shop__field">
                <label htmlFor={`${idBase}:conversion-reserve`}>
                  {copy.shopping.reserve.short}
                </label>
                <input
                  id={`${idBase}:conversion-reserve`}
                  type="text"
                  inputMode="decimal"
                  value={vm.conversion.reserveField.raw}
                  aria-invalid={vm.conversion.reserveField.problem === 'not_a_number' || undefined}
                  aria-describedby={`${idBase}:conversion-reserve-hint`}
                  onChange={(event) => {
                    if (vm.scope !== null)
                      commands.editDraft(vm.scope, 'reserve', event.currentTarget.value);
                  }}
                />
                <span id={`${idBase}:conversion-reserve-hint`} className="tp-shop__hint">
                  {copy.shopping.reserveHint.short}
                </span>
              </div>
              <Button
                tier="secondary"
                label={t.reviewed.short}
                {...(vm.conversion.reserveField.problem === null
                  ? {}
                  : { disabled: true, reasonId: `${idBase}:reviewed-reason` })}
                onClick={() => {
                  if (vm.conversion !== null && vm.conversion.reserveField.problem === null)
                    stage(vm.conversion.draft);
                }}
              />
              {vm.conversion.reserveField.problem === null ? null : (
                <span id={`${idBase}:reviewed-reason`}>{t.reserveFirst.short}</span>
              )}
            </div>
          )}
          {vm.showEditor ? (
            <div className="tp-saved-shopping__actions">
              <Button
                tier="secondary"
                label={t.save.short}
                {...(vm.save.enabled ? {} : { disabled: true, reasonId: `${idBase}:save-reason` })}
                busy={vm.save.sending}
                onClick={() => {
                  if (vm.save.command !== null) void commands.saveRun(vm.save.command);
                }}
              />
              <Button
                tier="quiet"
                label={t.discard.short}
                {...(vm.discard ? {} : { disabled: true, reasonId: `${idBase}:discard-reason` })}
                onClick={() => {
                  if (vm.scope !== null) commands.discardDraft(vm.scope);
                }}
              />
              {vm.save.enabled ? null : (
                <span id={`${idBase}:save-reason`}>{(reasonCopy ?? t.unavailable).short}</span>
              )}
              {vm.discard ? null : <span id={`${idBase}:discard-reason`}>{t.nothing.short}</span>}
            </div>
          ) : null}
          <QueueRefusal message={vm.refusal} />
        </details>
      )}
    </section>
  );
}
