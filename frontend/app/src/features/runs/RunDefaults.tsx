import { runtimeConfig as t } from '../../copy/runtimeConfig.ts';
import { runtime } from '../../copy/runtime.ts';
import { settings } from '../../copy/settings.ts';
import { selectRunDefaults } from '../../store/selectors/runDefaults.ts';
import { useDashboard, useView } from '../dashboard/context.ts';
import { ScopedSettingsModule } from '../settings/ScopedSettingsModule.tsx';
import { Button } from '../../ui/Button.tsx';
import { ActionRow } from '../../ui/ActionRow.tsx';
import { Fact, Facts } from '../../ui/Facts.tsx';
import { Disclosure } from '../../ui/Disclosure.tsx';
import { ServerValue } from '../../ui/ServerValue.tsx';
import { ValidationSummary } from './ValidationSummary.tsx';
import './runDefaults.css';

export function RunDefaults() {
  const { vm, status, instancePreset } = useView(selectRunDefaults);
  const { commands } = useDashboard();
  const invalid = vm?.fields.filter((field) => field.invalid !== null) ?? [];
  const first = invalid[0] ?? null;
  return (
    <div className="tp-run-defaults" data-run-defaults="true">
      {/* A problem opens it once; closed, it still names the first field that needs attention. */}
      <Disclosure
        label={t.fallback.short}
        initiallyOpen={invalid.length > 0}
        preview={
          <>
            <ValidationSummary problems={invalid.length} />
            {first?.invalid == null ? null : (
              <span className="tp-run-defaults__problem">
                {first.label === null ? null : (
                  <span>
                    <ServerValue kind="name" value={first.label} />
                    {t.needs.short}
                  </span>
                )}
                <span>{settings.invalid[first.invalid.reason].short}</span>
              </span>
            )}
          </>
        }
      >
        {instancePreset === null ? null : (
          <Facts>
            <Fact
              label={t.instancePreset.short}
              value={<ServerValue kind="name" value={instancePreset} />}
            />
          </Facts>
        )}
        {status === null ? null : <p>{runtime.settingsStates[status].short}</p>}
        {vm === null ? (
          status === null ? (
            <p>{runtime.settingsStates.no_module.short}</p>
          ) : null
        ) : (
          <ScopedSettingsModule
            vm={vm}
            legend={t.modules['run-defaults']}
            intro={t.fallbackNotice}
          />
        )}
        <ActionRow>
          <Button
            tier="quiet"
            label={runtime.checkSettings.short}
            onClick={commands.checkSettings}
          />
        </ActionRow>
      </Disclosure>
    </div>
  );
}
