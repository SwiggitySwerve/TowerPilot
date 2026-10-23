import { editingTarget as t } from '../../copy/editingTarget.ts';
import {
  editingSourceError,
  editingTargetVM,
  selectEditingTarget,
} from '../../store/selectors/editingTarget.ts';
import { TargetSourceError } from './TargetSourceError.tsx';
import { ServerValue } from '../../ui/ServerValue.tsx';
import { useView } from '../dashboard/context.ts';

/** Shared editor heading; target and permission come from the store's one projection. */
export function EditingTargetLine() {
  const target = useView(selectEditingTarget);
  const error = useView(editingSourceError);
  const vm = editingTargetVM(target);
  return (
    <div
      className="tp-profiles__scope"
      data-editing-target={target.name ?? ''}
      data-target-blocked={target.blocked ?? ''}
    >
      <div className="tp-profiles__summary">
        <span>{target.inactive ? t.editing.short : t.following.short}</span>
        {vm.name === null ? (
          <span>{t.none.short}</span>
        ) : (
          <ServerValue kind="name" value={vm.name} />
        )}
        {target.inactive ? <span>{t.inactive.short}</span> : null}
      </div>
      <div className="tp-profiles__summary">
        <span>{t.active.short}</span>
        {vm.active === null ? (
          <span>{t.none.short}</span>
        ) : (
          <ServerValue kind="name" value={vm.active} />
        )}
      </div>
      {target.blocked === null ? null : (
        <div className="tp-reason">{t.blocked[target.blocked].short}</div>
      )}
      <a href="#profiles">{t.change.short}</a>
      <TargetSourceError error={error} />
    </div>
  );
}
