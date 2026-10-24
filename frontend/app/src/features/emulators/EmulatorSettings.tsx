import { useState } from 'react';
import { copy } from '../../copy/catalogue.ts';
import { selectEmulatorSettings } from '../../store/selectors/emulatorSettings.ts';
import type { SettingsSaveCommand } from '../../store/selectors/settingsModule.ts';
import type { ServerText } from '../../copy/server.ts';
import { Button } from '../../ui/Button.tsx';
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx';
import { ServerValue } from '../../ui/ServerValue.tsx';
import { useDashboard, useView } from '../dashboard/context.ts';
import { SettingsModuleForm } from '../settings/SettingsModuleForm.tsx';

const t = copy.emulatorSettings;

/** Saved defaults and the separately reviewed context change share the settings editor. */
export function EmulatorSettings() {
  const { commands } = useDashboard();
  const vm = useView(selectEmulatorSettings);
  const [review, setReview] = useState<{
    readonly command: SettingsSaveCommand;
    readonly label: ServerText<'name'>;
  } | null>(null);
  const bindings = {
    onEdit: commands.editDraft,
    onDiscard: commands.discardDraft,
    onDismiss: commands.dismiss,
  };
  return (
    <>
      <section aria-labelledby="emulators-context-title">
        <h2 id="emulators-context-title">{t.context.short}</h2>
        {vm.state !== 'stale' ? null : <p>{t.stale.short}</p>}
        {vm.submittedFrom === null ? null : (
          <div className="tp-emulators__line">
            <span>{t.submittedFrom.short}</span>
            <ServerValue kind="id" value={vm.submittedFrom} />
          </div>
        )}
        {vm.active === null ? (
          <p>
            {
              (vm.state === 'ready'
                ? t.noModule
                : vm.state === 'not_read'
                  ? t.notRead
                  : t.unavailable
              ).short
            }
          </p>
        ) : (
          <SettingsModuleForm
            {...bindings}
            vm={vm.active}
            intro={t.switchIntro}
            onSave={(command) => {
              if (vm.intended !== null) setReview({ command, label: vm.intended });
            }}
          />
        )}
      </section>
      <section aria-labelledby="emulators-defaults-title">
        <h2 id="emulators-defaults-title">{t.configured.short}</h2>
        {vm.defaults === null ? (
          <p>
            {
              (vm.state === 'ready'
                ? t.noModule
                : vm.state === 'not_read'
                  ? t.notRead
                  : t.unavailable
              ).short
            }
          </p>
        ) : (
          <SettingsModuleForm
            {...bindings}
            vm={vm.defaults}
            legend={t.defaults}
            intro={t.nextStart}
            onSave={(command) => {
              void commands.saveSettings(command);
            }}
          />
        )}
        <Button
          tier="quiet"
          label={t.check.short}
          focusKey="emulators:defaults:read"
          onClick={commands.checkSettings}
        />
      </section>
      <ConfirmDialog
        open={review !== null}
        title={
          <>
            {t.confirmBefore.short}
            {review === null ? null : <ServerValue kind="name" value={review.label} />}
            {t.confirmAfter.short}
          </>
        }
        body={t.confirmBody.short}
        confirmLabel={t.confirm.short}
        cancelLabel={t.cancel.short}
        tier="primary"
        onCancel={() => {
          setReview(null);
        }}
        onConfirm={() => {
          if (review !== null) void commands.saveSettings(review.command);
          setReview(null);
        }}
      />
    </>
  );
}
