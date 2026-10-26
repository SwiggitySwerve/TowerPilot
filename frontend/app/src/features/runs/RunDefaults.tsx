import { runtimeConfig as t } from '../../copy/runtimeConfig.ts';
import { runtime } from '../../copy/runtime.ts';
import { selectRunDefaults } from '../../store/selectors/runDefaults.ts';
import { useDashboard, useView } from '../dashboard/context.ts';
import { ScopedSettingsModule } from '../settings/ScopedSettingsModule.tsx';
import { Button } from '../../ui/Button.tsx';
import { ServerValue } from '../../ui/ServerValue.tsx';
import './runDefaults.css';

export function RunDefaults() {
  const { vm, status, instancePreset } = useView(selectRunDefaults);
  const { commands } = useDashboard();
  return (
    <details className="tp-run-defaults" data-run-defaults="true">
      <summary>{t.fallback.short}</summary>
      {instancePreset === null ? null : (
        <p>
          {t.instancePreset.short}
          <ServerValue kind="name" value={instancePreset} />
        </p>
      )}
      {status === null ? null : <p>{runtime.settingsStates[status].short}</p>}
      {vm === null ? (
        status === null ? (
          <p>{runtime.settingsStates.no_module.short}</p>
        ) : null
      ) : (
        <ScopedSettingsModule vm={vm} legend={t.modules['run-defaults']} intro={t.fallbackNotice} />
      )}
      <Button tier="quiet" label={runtime.checkSettings.short} onClick={commands.checkSettings} />
    </details>
  );
}
