import { createElement, useEffect, useState } from 'react';
import { createAbilitiesApi } from '../api/abilities.ts';
import { createAbilitiesStore, type AbilitiesStore } from '../store/abilities.ts';
import type { DashboardStore } from '../store/dashboardStore.ts';
import { AbilitiesPage } from '../features/abilities/AbilitiesPage.tsx';
import { useDashboard } from '../features/dashboard/context.ts';
import { selectEditingTarget } from '../store/selectors/editingTarget.ts';
const editors = new WeakMap<DashboardStore, AbilitiesStore>();
export function ConnectedAbilitiesPage() {
  const dashboard = useDashboard().store;
  const [abilities] = useState(() => {
    let editor = editors.get(dashboard);
    if (editor === undefined) {
      editor = createAbilitiesStore(createAbilitiesApi());
      editors.set(dashboard, editor);
    }
    return editor;
  });
  useEffect(() => {
    const sync = () => {
      const s = dashboard.getSnapshot();
      abilities.setTarget(s.contextConfirmed ? s.context : null, s.epoch, selectEditingTarget(s));
    };
    const unsubscribe = dashboard.subscribe(sync);
    sync();
    return unsubscribe;
  }, [dashboard, abilities]);
  return createElement(AbilitiesPage, { abilities });
}
