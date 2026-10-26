import type { CopyEntry } from '../../copy/text.ts';
import { runtime as t } from '../../copy/runtime.ts';
import type { RuntimeRead, RuntimeStore } from '../../store/runtime.ts';
import { selectRuntime, type RuntimeFields } from '../../store/selectors/runtime.ts';
import { useStoreSelector, viewEqual } from '../../store/store.ts';
import type { ServerText } from '../../copy/server.ts';
import { ServerValue } from '../../ui/ServerValue.tsx';
import { Button } from '../../ui/Button.tsx';
import { RegionBody } from '../../ui/Region.tsx';

export function Fields({
  fields,
  labels,
}: {
  readonly fields: RuntimeFields;
  readonly labels: Readonly<Record<string, CopyEntry>>;
}) {
  return (
    <dl className="tp-runtime__facts">
      {fields.map((field) => (
        <div key={field.key}>
          <dt>{labels[field.key]?.short ?? t.notReported.short}</dt>
          <dd>
            {field.value === null ? (
              t.notReported.short
            ) : (
              <ServerValue kind="detail" value={field.value} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
export function ReadState({
  read,
  error,
}: {
  readonly read: RuntimeRead;
  readonly error: ServerText<'message'> | null;
}) {
  return (
    <div className="tp-runtime__read">
      {read.busy ? <p>{t.loading.short}</p> : null}
      {read.error === null ? null : (
        <div className="tp-runtime__notice">
          <p>{read.loadedAt === null ? t.noRead.short : t.stale.short}</p>
          <p>{t[read.error].short}</p>
          {error === null ? null : (
            <p>
              <ServerValue kind="message" value={error} />
            </p>
          )}
        </div>
      )}
      {read.loadedAt === null ? null : (
        <p className="tp-runtime__muted">
          <time>{t.loaded(read.loadedAt)}</time>
        </p>
      )}
    </div>
  );
}
export function IdentitySection({ runtime }: { readonly runtime: RuntimeStore }) {
  const vm = useStoreSelector(runtime, selectRuntime, viewEqual);
  return (
    <RegionBody>
      <Button
        tier="secondary"
        label={t.refreshIdentity.short}
        busy={vm.identity.busy}
        {...(vm.identity.busy ? { disabled: true, reasonId: 'runtime-identity-busy' } : {})}
        onClick={runtime.refreshIdentity}
      />
      {vm.identity.busy ? <p id="runtime-identity-busy">{t.busy.short}</p> : null}
      <ReadState read={vm.identity} error={vm.identityError} />
      <p>{t.fingerprint.short}</p>
      <p>{t.workerSafety.short}</p>
      {vm.identityVM === null ? null : (
        <>
          <h3>{t.source.short}</h3>
          <p data-source-state={vm.identityVM.source}>
            {t.sourceStates[vm.identityVM.source].short}
          </p>
          <p>{t.age(vm.identityVM.capturedAge)}</p>
          <Fields fields={vm.identityVM.server} labels={t.serverFields} />
          <Fields fields={vm.identityVM.runtime} labels={t.runtimeFields} />
          <h3>{t.process.short}</h3>
          <Fields fields={vm.identityVM.process} labels={t.processFields} />
          <h3>{t.workers.short}</h3>
          {vm.identityVM.workers.length === 0 ? (
            <p>{t.noWorkers.short}</p>
          ) : (
            <ul className="tp-runtime__workers">
              {vm.identityVM.workers.map((worker) => (
                <li key={worker.key}>
                  <p data-worker-alive={worker.alive}>{t.aliveStates[worker.alive].short}</p>
                  <Fields fields={worker.fields} labels={t.workerFields} />
                </li>
              ))}
            </ul>
          )}
          <details>
            <summary>{t.rawIdentity.short}</summary>
            <pre>
              {vm.identityVM.raw === null ? (
                t.notReported.short
              ) : (
                <ServerValue kind="detail" value={vm.identityVM.raw} />
              )}
            </pre>
          </details>
        </>
      )}
    </RegionBody>
  );
}
