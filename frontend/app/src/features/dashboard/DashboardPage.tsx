import { copy } from '../../copy/catalogue.ts';
import { RegionBoundary } from '../../ui/RegionBoundary.tsx';
import { ControlRegion } from './control/ControlRegion.tsx';
import { FaultPoint, useEpochKey, usePartError } from './context.ts';
import { NeedsYou } from './needsYou/NeedsYou.tsx';
import { PlanAndHistory } from './recent/PlanAndHistory.tsx';
import { RevocationFallback } from './shared/RevocationFallback.tsx';
import { Toasts } from './shared/Toasts.tsx';
import { StartNext } from './startNext/StartNext.tsx';
import { ThisBattle } from './thisBattle/ThisBattle.tsx';
import { TopBar } from './topBar/TopBar.tsx';
import { Preview } from './Preview.tsx';
import './dashboard.css';

/**
 * The Dashboard (spec 2.1): the top bar, then the five regions in one fixed
 * order at every width, in a content column capped at 1100 px. Every part has
 * its own boundary whose fallback keeps Pause harvesting and Turn input off
 * (S-090, S-091).
 */
export function DashboardPage() {
  return (
    <>
      <header className="tp-topbar">
        <RegionBoundary
          fallback={<RevocationFallback part="topBar" />}
          resetKey={useEpochKey()}
          onError={usePartError('topBar')}
        >
          <FaultPoint part="topBar" />
          <TopBar title={copy.dashboard.shell.pageName.short} />
        </RegionBoundary>
      </header>
      <main id="main" className="tp-main" tabIndex={-1}>
        <FaultPoint part="page" />
        <div className="tp-dashboard-layout">
          <div className="tp-dashboard">
            <ControlRegion />
            <NeedsYou />
            <ThisBattle />
            <StartNext />
            <PlanAndHistory />
          </div>
          <Preview />
        </div>
        <RegionBoundary fallback={null} onError={usePartError('toasts')}>
          <Toasts />
        </RegionBoundary>
      </main>
    </>
  );
}
