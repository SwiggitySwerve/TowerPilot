import { useEffect, useState, useSyncExternalStore } from 'react';
import { recognitionAdvanced as t } from '../../../copy/recognitionAdvanced.ts';
import type { RecognitionAdvancedStore } from '../../../store/recognitionAdvanced.ts';
import { Region, RegionBody } from '../../../ui/Region.tsx';
import { Analysis } from './Analysis.tsx';
import { Coverage } from './Coverage.tsx';
import { CropEditor } from './CropEditor.tsx';
import './advanced.css';
export interface AdvancedRepairsProps {
  readonly store: RecognitionAdvancedStore;
  readonly run: string | null;
}
/** R9-R11. Observation and human image repair have no game-input controls. */
export function AdvancedRepairs({ store, run }: AdvancedRepairsProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    store.setRun(run);
  }, [store, run]);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      const s = store.getSnapshot();
      const target = s.key === null ? undefined : s.targets[s.key];
      if (
        target?.analysisBusy === false &&
        (target.selectedOperation !== '' || target.launch?.phase === 'unconfirmed')
      )
        void store.readAnalysis();
    }, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [store]);
  return (
    <div className="tp-advanced">
      <Region id="recognition-analysis" title={t.analysis.short} fallback={t.unavailable.short}>
        <RegionBody>
          <Analysis store={store} state={state} now={now} />
        </RegionBody>
      </Region>
      <Region id="recognition-coverage" title={t.coverage.short} fallback={t.unavailable.short}>
        <RegionBody>
          <Coverage store={store} state={state} now={now} />
        </RegionBody>
      </Region>
      <Region id="recognition-crop" title={t.crop.short} fallback={t.unavailable.short}>
        <RegionBody>
          <CropEditor store={store} state={state} now={now} />
        </RegionBody>
      </Region>
    </div>
  );
}
