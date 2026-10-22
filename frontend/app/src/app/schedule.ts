import { createElement, useEffect, useState } from 'react';
import { createScheduleApi } from '../api/schedule.ts';
import { SchedulePage } from '../features/schedule/SchedulePage.tsx';
import { useDashboard } from '../features/dashboard/context.ts';
import { createScheduleStore, type ScheduleStore } from '../store/schedule.ts';
import type { DashboardStore } from '../store/dashboardStore.ts';

const editors = new WeakMap<DashboardStore, ScheduleStore>();
/** The app wires transport to the store; the feature only renders the store. */
export function ConnectedSchedulePage() {
  const dashboard = useDashboard().store;
  const [schedule] = useState(() => {
    let editor = editors.get(dashboard);
    if (editor === undefined) {
      editor = createScheduleStore(createScheduleApi());
      editors.set(dashboard, editor);
    }
    return editor;
  });
  useEffect(() => {
    const sync = () => {
      const state = dashboard.getSnapshot();
      schedule.setTarget(state.contextConfirmed ? state.context : null, state.epoch);
    };
    const unsubscribe = dashboard.subscribe(sync);
    sync();
    return unsubscribe;
  }, [dashboard, schedule]);
  return createElement(SchedulePage, { schedule });
}
