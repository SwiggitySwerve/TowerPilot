import { copy } from '../../copy/catalogue.ts';
import {
  draftChanges,
  includeUpgrade,
  leaveOutUpgrade,
  moveUpgrade,
  setExcluded,
} from '../../core/shoppingPlan.ts';
import { selectShoppingLive } from '../../store/selectors/shoppingLive.ts';
import { Button } from '../../ui/Button.tsx';
import { pageHref } from '../../ui/routes.ts';
import { useDashboard, useView } from '../dashboard/context.ts';
import { QueueEditor } from '../shopping/QueueEditor.tsx';
import { QueueRefusal } from '../shopping/QueueRefusal.tsx';
import './shoppingLive.css';
const t = copy.shoppingLive;

/** SQ7/SQ12: presentation of the applied plan and this generation's draft. */
export function LiveShopping() {
  const vm = useView(selectShoppingLive);
  const { commands } = useDashboard();
  const apply = (next: typeof vm.draft) => {
    for (const [key, value] of draftChanges(vm.draft, next))
      commands.editDraft(vm.scope, key, value);
  };
  return (
    <section className="tp-shopping-live" aria-labelledby="shopping-live-title">
      <h3 id="shopping-live-title">{t.title.short}</h3>
      <p>{t.scope.short}</p>
      {vm.supported ? (
        <details open>
          <summary>{t.edit.short}</summary>
          <QueueEditor
            vm={vm.editor}
            idBase="shopping-live"
            onEdit={(key, value) => {
              commands.editDraft(vm.scope, key, value);
            }}
            onInclude={(id) => {
              apply(includeUpgrade(vm.base, vm.draft, id));
            }}
            onLeaveOut={(id) => {
              apply(leaveOutUpgrade(vm.draft, id));
            }}
            onExclude={(id, excluded) => {
              apply(setExcluded(vm.draft, id, excluded));
            }}
            onMove={(id, step) => {
              const next = moveUpgrade(vm.base, vm.draft, id, step);
              if (next === null) return null;
              apply(next);
              return vm.editor.entries.findIndex((entry) => entry.id === id) + 1 + step;
            }}
          />
          <p>{t.overrides.short}</p>
          {vm.routineEnabled === null ? null : (
            <p>{vm.routineEnabled ? t.on.short : t.off.short}</p>
          )}
          {typeof vm.routineInterval === 'number' ? <p>{t.interval(vm.routineInterval)}</p> : null}
          <div className="tp-runs__actions">
            <Button
              tier="secondary"
              label={t.save.short}
              {...(vm.command === null ? { disabled: true, reasonId: 'shopping-live-reason' } : {})}
              onClick={() => {
                if (vm.command !== null) void commands.saveLive(vm.command);
              }}
            />
            {vm.discard ? (
              <Button
                tier="quiet"
                label={t.discard.short}
                onClick={() => {
                  commands.discardDraft(vm.scope);
                }}
              />
            ) : null}
          </div>
          <QueueRefusal message={vm.refusal} />
        </details>
      ) : null}
      {vm.reason === null ? null : (
        <div id="shopping-live-reason">
          {
            (
              Object.entries(t.reasons).find(([key]) => key === vm.reason)?.[1] ??
              t.reasons.unsupported
            ).short
          }
        </div>
      )}
      <a href={pageHref('dashboard')}>{t.dashboard.short}</a>
    </section>
  );
}
