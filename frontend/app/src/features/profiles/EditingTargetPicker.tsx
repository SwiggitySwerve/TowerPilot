import { useState } from 'react';
import { editingTarget as t } from '../../copy/editingTarget.ts';
import { editingFilesFailed, selectEditingChoices } from '../../store/selectors/editingTarget.ts';
import { Button } from '../../ui/Button.tsx';
import { ServerOption } from '../../ui/ServerValue.tsx';
import { useDashboard, useView } from '../dashboard/context.ts';
import { EditingTargetLine } from './EditingTargetLine.tsx';

export function EditingTargetPicker() {
  const { commands } = useDashboard();
  const epoch = useView((state) => state.epoch);
  const choices = useView(selectEditingChoices);
  const failed = useView(editingFilesFailed);
  const [pick, setPick] = useState('');
  const available = choices.some((choice) => choice.key === pick);
  return (
    <fieldset className="tp-profiles__form" data-form="editing-target">
      <legend>{t.title.short}</legend>
      <EditingTargetLine />
      <div>{t.scope.short}</div>
      {failed ? (
        <div role="alert">
          {t.listFailed.short}
          <Button
            tier="secondary"
            label={t.retryList.short}
            onClick={commands.checkEditingProfiles}
          />
        </div>
      ) : null}
      <label className="tp-profiles__field">
        <span>{t.picker.short}</span>
        <select
          value={available ? pick : ''}
          onChange={(event) => {
            setPick(event.currentTarget.value);
          }}
        >
          <option value="">{t.choose.short}</option>
          {choices.map((choice) =>
            choice.name === null ? null : (
              <ServerOption key={choice.key} value={choice.key} label={choice.name} />
            ),
          )}
        </select>
      </label>
      <div className="tp-profiles__actions">
        <span className="tp-profiles__action">
          {available ? (
            <Button
              tier="secondary"
              label={t.pick.short}
              onClick={() => {
                commands.pickEditingTarget({ epoch, name: pick });
              }}
            />
          ) : (
            <Button
              tier="secondary"
              label={t.pick.short}
              disabled
              reasonId="editing-target-pick-reason"
              onClick={() => undefined}
            />
          )}
          {available ? null : (
            <span id="editing-target-pick-reason" className="tp-reason">
              {t.choose.short}
            </span>
          )}
        </span>
        <Button
          tier="quiet"
          label={t.return.short}
          onClick={() => {
            commands.returnEditingToActive({ epoch });
          }}
        />
      </div>
    </fieldset>
  );
}
