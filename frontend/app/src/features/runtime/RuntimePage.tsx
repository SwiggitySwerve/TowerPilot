import { useEffect } from 'react';
import type { RuntimeStore } from '../../store/runtime.ts';
import { runtime as t } from '../../copy/runtime.ts';
import { selectRuntimeSettings } from '../../store/selectors/runtime.ts';
import { useDashboard, useEpochKey, usePartError, useView } from '../dashboard/context.ts';
import { TopBar } from '../dashboard/topBar/TopBar.tsx';
import { SettingsModuleForm } from '../settings/SettingsModuleForm.tsx';
import { Region, RegionBody } from '../../ui/Region.tsx';
import { ServerValue } from '../../ui/ServerValue.tsx';
import { Button } from '../../ui/Button.tsx';
import { IdentitySection } from './IdentitySection.tsx';
import { DiagnosticsSection } from './DiagnosticsSection.tsx';
import './runtime.css';

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
      <div className="tp-runtime__settings">
        {vm.modules.map((module) => (
          <div key={module.id} data-runtime-module={module.id}>
            <p className="tp-runtime__scope">
              {module.scope === 'instance'
                ? t.instanceScope.short
                : module.scope === 'machine'
                  ? t.machineScope.short
                  : t.unknownScope.short}
            </p>
            {module.status === 'ready' || module.status === 'stale' ? null : (
              <p data-settings-state={module.status}>{t.settingsStates[module.status].short}</p>
            )}
            {module.vm === null ? (
              <h3>{t.modules[module.id].short}</h3>
            ) : (
              <SettingsModuleForm
                vm={module.vm}
                legend={t.modules[module.id]}
                onEdit={commands.editDraft}
                onDiscard={commands.discardDraft}
                onSave={(command) => {
                  void commands.saveSettings(command);
                }}
                onDismiss={commands.dismiss}
              />
            )}
          </div>
        ))}
      </div>
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
        <TopBar title={t.pageName.short} readOnly />
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
