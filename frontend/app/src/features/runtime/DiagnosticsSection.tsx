import { useEffect } from 'react';
import { RUNTIME_FILTERS, runtimeHash } from '../../core/runtime.ts';
import { runtime as t } from '../../copy/runtime.ts';
import type { RuntimeStore } from '../../store/runtime.ts';
import { selectRuntime } from '../../store/selectors/runtime.ts';
import { useStoreSelector, viewEqual } from '../../store/store.ts';
import { Button } from '../../ui/Button.tsx';
import { RegionBody } from '../../ui/Region.tsx';
import { ServerValue } from '../../ui/ServerValue.tsx';
import { Fields, ReadState } from './IdentitySection.tsx';

function filterLabel(key: string) {
  return (
    Object.entries(t.filterLabels).find(([name]) => name === key)?.[1].short ?? t.notReported.short
  );
}
function download(runtime: RuntimeStore) {
  const json = runtime.exportJSON();
  if (json === null) return;
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'runtime-diagnostics.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

export function DiagnosticsSection({ runtime }: { readonly runtime: RuntimeStore }) {
  const vm = useStoreSelector(runtime, selectRuntime, viewEqual);
  // Visibility owns the timer. Reads neither announce nor change focus or native disclosure state.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const sync = () => {
      if (timer !== null) clearInterval(timer);
      timer =
        vm.auto && document.visibilityState === 'visible'
          ? setInterval(runtime.refreshEvents, 5000)
          : null;
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      if (timer !== null) clearInterval(timer);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [runtime, vm.auto]);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const result = vm.diagnosticsVM;
  return (
    <RegionBody>
      <details className="tp-runtime__filters" open>
        <summary>{t.filters.short}</summary>
        <div className="tp-runtime__filter-grid">
          {RUNTIME_FILTERS.map((key) => (
            <label key={key}>
              <span>{t.filterLabels[key].short}</span>
              <input
                type="text"
                value={vm.draft.exact[key] ?? ''}
                onChange={(event) => {
                  runtime.edit(key, event.currentTarget.value);
                }}
              />
            </label>
          ))}
          <label>
            <span>{t.since(zone)}</span>
            <input
              type="datetime-local"
              step="0.001"
              value={vm.draft.since}
              aria-invalid={vm.problem === 'since' ? true : undefined}
              aria-describedby={vm.problem === 'since' ? 'runtime-filter-error' : undefined}
              onChange={(event) => {
                runtime.edit('since', event.currentTarget.value);
              }}
            />
          </label>
          <label>
            <span>{t.limit.short}</span>
            <input
              type="text"
              inputMode="numeric"
              value={vm.draft.limit}
              aria-invalid={vm.problem === 'limit' ? true : undefined}
              aria-describedby={vm.problem === 'limit' ? 'runtime-filter-error' : undefined}
              onChange={(event) => {
                runtime.edit('limit', event.currentTarget.value);
              }}
            />
          </label>
        </div>
        <label className="tp-runtime__check">
          <input
            type="checkbox"
            checked={vm.draft.failures}
            onChange={(event) => {
              runtime.edit('failures', event.currentTarget.checked);
            }}
          />
          <span>{t.failures.short}</span>
        </label>
        {vm.problem === null ? null : (
          <p id="runtime-filter-error" className="tp-runtime__notice">
            {t.filterProblems[vm.problem].short}
          </p>
        )}
        <Button
          tier="secondary"
          label={t.apply.short}
          {...(vm.problem === null ? {} : { disabled: true, reasonId: 'runtime-filter-error' })}
          onClick={() => {
            const query = runtime.apply();
            if (query !== null) window.history.replaceState(null, '', runtimeHash(query));
          }}
        />
      </details>
      <div className="tp-runtime__actions">
        <Button
          tier="secondary"
          label={t.refreshEvents.short}
          busy={vm.events.busy}
          {...(vm.events.busy ? { disabled: true, reasonId: 'runtime-events-busy' } : {})}
          onClick={runtime.refreshEvents}
        />
        <Button
          tier="quiet"
          label={t.export.short}
          {...(result === null ? { disabled: true, reasonId: 'runtime-export-reason' } : {})}
          onClick={() => {
            download(runtime);
          }}
        />
        {result === null ? <span id="runtime-export-reason">{t.noExport.short}</span> : null}
        {vm.events.busy ? <span id="runtime-events-busy">{t.busy.short}</span> : null}
      </div>
      <label className="tp-runtime__check">
        <input
          type="checkbox"
          checked={vm.auto}
          onChange={(event) => {
            runtime.setAuto(event.currentTarget.checked);
          }}
        />
        <span>{t.auto.short}</span>
      </label>
      <ReadState read={vm.events} error={vm.eventsError} />
      {result === null ? null : (
        <>
          <details>
            <summary>{t.applied.short}</summary>
            <pre>
              {result.applied === null ? (
                t.notReported.short
              ) : (
                <ServerValue kind="detail" value={result.applied} />
              )}
            </pre>
          </details>
          <div className="tp-runtime__evidence">
            <section aria-labelledby="runtime-coverage">
              <h3 id="runtime-coverage">{t.coverage.short}</h3>
              <Fields fields={result.coverage} labels={t.coverageFields} />
            </section>
            <section aria-labelledby="runtime-writer">
              <h3 id="runtime-writer">{t.writer.short}</h3>
              <p>{t.writerNote.short}</p>
              <Fields fields={result.writer} labels={t.writerFields} />
            </section>
          </div>
          <p>{t.failureNote.short}</p>
          {result.rows.length === 0 ? (
            <p>{t.empty.short}</p>
          ) : (
            <ul className="tp-runtime__events">
              {result.rows.map((row) => (
                <li key={row.key}>
                  <details data-event-key={row.key}>
                    <summary>
                      <span>
                        {row.kind === null ? (
                          t.notReported.short
                        ) : (
                          <ServerValue kind="detail" value={row.kind} />
                        )}
                      </span>
                      <span>
                        {t.eventTime.short}
                        {t.number(row.time)}
                      </span>
                      <span>
                        {row.failure === 'failure'
                          ? t.failure.short
                          : row.failure === 'noFailure'
                            ? t.noFailure.short
                            : t.unknownFailure.short}
                      </span>
                      <span className="tp-runtime__ids">
                        {row.ids
                          .filter((field) => field.value !== null)
                          .map((field) => (
                            <span key={field.key}>
                              {filterLabel(field.key)}
                              {field.value === null ? null : (
                                <ServerValue kind="detail" value={field.value} />
                              )}
                            </span>
                          ))}
                      </span>
                    </summary>
                    <h4>{t.raw.short}</h4>
                    <pre>
                      {row.raw === null ? (
                        t.notReported.short
                      ) : (
                        <ServerValue kind="detail" value={row.raw} />
                      )}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </RegionBody>
  );
}
