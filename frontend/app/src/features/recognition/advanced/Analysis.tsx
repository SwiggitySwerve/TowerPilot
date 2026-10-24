import { recognitionAdvanced as t } from '../../../copy/recognitionAdvanced.ts';
import type {
  RecognitionAdvancedState,
  RecognitionAdvancedStore,
} from '../../../store/recognitionAdvanced.ts';
import { selectAdvanced } from '../../../store/selectors/recognitionAdvanced.ts';
import { Button } from '../../../ui/Button.tsx';
import { Coordinates, Data, Values } from './Data.tsx';
export function Analysis({
  store,
  state,
  now,
}: {
  readonly store: RecognitionAdvancedStore;
  readonly state: RecognitionAdvancedState;
  readonly now: number;
}) {
  const vm = selectAdvanced(state, now);
  const target = vm.target;
  const a = vm.analysis;
  const blocked = state.context === null || target?.checking === true || vm.launchPending;
  const answer = vm.launch;
  return (
    <>
      <p>{t.observation.short}</p>
      <div className="tp-advanced__actions">
        <Button
          tier="secondary"
          label={t.analyze.short}
          onClick={() => {
            void store.analyze();
          }}
          {...(blocked ? { disabled: true, reasonId: 'analysis-blocked' } : {})}
        />
        <Button
          tier="quiet"
          label={t.readAnalysis.short}
          onClick={() => {
            void store.readAnalysis();
          }}
          {...(state.context === null || target?.analysisBusy === true
            ? { disabled: true, reasonId: 'analysis-read-blocked' }
            : {})}
        />
      </div>
      {blocked ? (
        <p id="analysis-blocked">
          {state.context === null
            ? t.noTarget.short
            : target?.checking === true
              ? t.checking.short
              : t.pending.short}
        </p>
      ) : null}
      {state.context === null || target?.analysisBusy === true ? (
        <p id="analysis-read-blocked">
          {state.context === null ? t.noTarget.short : t.reading.short}
        </p>
      ) : null}
      {target?.contextError === true ? <p role="status">{t.contextError.short}</p> : null}
      {answer.kind !== 'none' ? (
        <div role="status">
          <p>
            {answer.kind === 'accepted'
              ? t.accepted.short
              : answer.kind === 'refused'
                ? t.notStarted.short
                : answer.kind === 'sending'
                  ? t.sending.short
                  : t.unknown.short}
          </p>
          {answer.message !== null ? <Data value={answer.message} /> : null}
          {answer.kind === 'refused' ? (
            <>
              <Data value={answer.code} />
              <Data value={answer.error} />
            </>
          ) : null}
        </div>
      ) : null}
      <label className="tp-advanced__field">
        {t.operation.short}
        <input
          value={target?.selectedOperation ?? ''}
          onChange={(e) => {
            store.selectOperation(e.target.value);
          }}
        />
      </label>
      {target?.analysisAt == null ? (
        <p>{t.noAnalysis.short}</p>
      ) : (
        <>
          {target.analysisError ? <p>{t.readError.short}</p> : null}
          {vm.analysisStale ? <p>{t.stale.short}</p> : null}
          <div role="status">
            {a.status === null ? t.unavailable.short : <Data value={a.status} />}
            {a.message === null ? null : <Data value={a.message} />}
            {a.code === null ? null : <Data value={a.code} />}
          </div>
          {a.available ? (
            <>
              <p>
                {t.screen.short}
                <Data value={a.screen} />
              </p>
              <p>
                {t.candidates.short}
                <Values values={a.candidates} />
              </p>
              <p>
                {t.tested.short}
                <Values values={[a.tested, a.total, a.completed]} />
              </p>
              <p>
                {t.captured.short}
                <Data value={a.capturedAt} />
              </p>
            </>
          ) : null}
          {a.frame !== null && !target.snapshotError ? (
            <div className="tp-advanced__snapshot">
              <img
                key={a.frame}
                src={a.frame}
                alt={t.snapshot.short}
                onError={store.snapshotFailed}
              />
              {a.size !== null ? (
                <svg
                  aria-hidden="true"
                  viewBox={`0 0 ${a.size.width} ${a.size.height}`}
                  preserveAspectRatio="none"
                >
                  {a.matches.map((m) =>
                    m.rect === null ? null : (
                      <rect
                        key={m.id}
                        x={m.rect.x}
                        y={m.rect.y}
                        width={m.rect.w}
                        height={m.rect.h}
                      />
                    ),
                  )}
                </svg>
              ) : null}
            </div>
          ) : null}
          {target.snapshotError ? <p>{t.snapshotError.short}</p> : null}
          {a.noMatches ? <p>{t.noMatches.short}</p> : null}
          <ul>
            {a.matches.map((m) => (
              <li key={m.id}>
                <p>
                  {t.names.short}
                  <Values values={m.names} />
                </p>
                <p>
                  {t.roles.short}
                  {m.roles.length === 0 ? (
                    <span>{t.unknownRole.short}</span>
                  ) : (
                    <Values values={m.roles} />
                  )}
                </p>
                <p>
                  {t.rect.short}
                  <Coordinates value={m.rect} />
                  {t.inliers.short}
                  <Data value={m.inliers} />
                </p>
                {m.ambiguous ? <p>{t.ambiguous.short}</p> : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
