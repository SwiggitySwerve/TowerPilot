import { useEffect } from 'react';
import type { RuntimeStore } from '../../store/runtime.ts';
import { runtime as t } from '../../copy/runtime.ts';
import { selectRuntimeSettings } from '../../store/selectors/runtime.ts';
import { useDashboard, useEpochKey, usePartError, useView } from '../dashboard/context.ts';
import { TopBar } from '../dashboard/topBar/TopBar.tsx';
import { ScopedSettingsModule } from '../settings/ScopedSettingsModule.tsx';
import { runtimeConfig as c } from '../../copy/runtimeConfig.ts';
import { Region, RegionBody } from '../../ui/Region.tsx';
import { ServerValue } from '../../ui/ServerValue.tsx';
import { Button } from '../../ui/Button.tsx';
import { IdentitySection } from './IdentitySection.tsx';
import { DiagnosticsSection } from './DiagnosticsSection.tsx';
import './runtime.css';

const GROUPS: readonly ('defaults' | 'overrides' | 'machine')[] = [
  'defaults',
  'overrides',
  'machine',
];

function SettingsSection() {
  const vm = useView(selectRuntimeSettings);
  const { commands } = useDashboard();
  return (
    <RegionBody>
      <p>{t.settingsSafety.short}</p>
      {vm.readFailure === null ? null : (
        <div className="tp-runtime__notice" data-settings-read="stale">
          <p>
            {vm.loadedAt === null
              ? t.settingsStates.unavailable.short
              : t.settingsStates.stale.short}
          </p>
          <p>
            {vm.readFailure.network
              ? t.network.short
              : t.settingsFailureStatus(vm.readFailure.status)}
          </p>
          {vm.readFailure.error === null ? null : (
            <p>
              <ServerValue kind="message" value={vm.readFailure.error} />
            </p>
          )}
        </div>
      )}
      {vm.loadedAt === null ? null : (
        <p className="tp-runtime__muted">
          <time>{t.loaded(vm.loadedAt)}</time>
        </p>
      )}
      <details>
        <summary>{t.target.short}</summary>
        <pre>
          {vm.target === null ? (
            t.notReported.short
          ) : (
            <ServerValue kind="detail" value={vm.target} />
          )}
        </pre>
      </details>
      <Button tier="quiet" label={t.checkSettings.short} onClick={commands.checkSettings} />
      {GROUPS.map((group) => (
        <section key={group} data-runtime-group={group}>
          <h3>
            {group === 'overrides' ? (
              <>
                {c.overrides.short}
                {vm.emulator === null ? (
                  t.notReported.short
                ) : (
                  <ServerValue kind="name" value={vm.emulator} />
                )}
                {c.openId.short}
                {vm.instance === null ? (
                  t.notReported.short
                ) : (
                  <ServerValue kind="id" value={vm.instance} />
                )}
                {c.closeId.short}
              </>
            ) : (
              c[group].short
            )}
          </h3>
          <div className="tp-runtime__settings">
            {vm.modules
              .filter((module) =>
                group === 'defaults'
                  ? module.id.endsWith('-defaults')
                  : group === 'machine'
                    ? module.id === 'tap' || module.id === 'logging'
                    : module.scope === 'instance' ||
                      ['loop', 'missions', 'fleet'].includes(module.id),
              )
              .map((module) => (
                <div key={module.id} data-runtime-module={module.id}>
                  <p className="tp-runtime__scope">
                    {module.id.endsWith('-defaults')
                      ? c.fallbackScope.short
                      : module.scope === 'instance'
                        ? t.instanceScope.short
                        : module.scope === 'machine'
                          ? t.machineScope.short
                          : t.unknownScope.short}
                  </p>
                  {module.status === 'ready' || module.status === 'stale' ? null : (
                    <p data-settings-state={module.status}>
                      {t.settingsStates[module.status].short}
                    </p>
                  )}
                  {module.vm === null ? (
                    <h4>{c.modules[module.id].short}</h4>
                  ) : (
                    <ScopedSettingsModule
                      vm={module.vm}
                      legend={c.modules[module.id]}
                      intro={
                        module.id.endsWith('-defaults')
                          ? c.defaultsNotice
                          : group === 'overrides'
                            ? c.overrideNotice
                            : c.machineNotice
                      }
                    />
                  )}
                </div>
              ))}
          </div>
        </section>
      ))}
    </RegionBody>
  );
}

export function RuntimePage({ runtime }: { readonly runtime: RuntimeStore }) {
  const { commands } = useDashboard();
  const epoch = useEpochKey();
  const settingsError = usePartError('runtimeSettings');
  const identityError = usePartError('runtimeIdentity');
  const eventsError = usePartError('runtimeDiagnostics');
  useEffect(() => {
    commands.openRuntime(true);
    return () => {
      commands.openRuntime(false);
    };
  }, [commands]);
  return (
    <>
      <header className="tp-topbar">
        <TopBar pageId="runtime" title={t.pageName.short} readOnly />
      </header>
      <main id="main" className="tp-main tp-runtime" tabIndex={-1}>
        <p>{t.intro.short}</p>
        <Region
          id="runtimeSettings"
          title={t.settings.short}
          fallback={t.fallback.short}
          resetKey={epoch}
          onError={settingsError}
        >
          <SettingsSection />
        </Region>
        <Region
          id="runtimeIdentity"
          title={t.identity.short}
          fallback={t.fallback.short}
          resetKey={epoch}
          onError={identityError}
        >
          <IdentitySection runtime={runtime} />
        </Region>
        <Region
          id="runtimeDiagnostics"
          title={t.diagnostics.short}
          fallback={t.fallback.short}
          resetKey={epoch}
          onError={eventsError}
        >
          <DiagnosticsSection runtime={runtime} />
        </Region>
      </main>
    </>
  );
}
