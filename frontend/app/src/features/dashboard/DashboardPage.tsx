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
 * The Dashboard (spec 2.1): the top bar, then the regions. At wide widths the
 * controls and lists fill the main column and the screen stays in view in the
 * side column; narrower layouts are in preview.css. Every part has
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
          <div className="tp-dashboard-side">
            <Preview />
          </div>
        </div>
        <RegionBoundary fallback={null} onError={usePartError('toasts')}>
          <Toasts />
        </RegionBoundary>
      </main>
    </>
  );
}
