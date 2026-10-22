import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { schedule as t } from '../../copy/schedule.ts';
import { currentSchedule, type ScheduleStore } from '../../store/schedule.ts';
import type { ServerText } from '../../copy/server.ts';
import { FIRST_DAY, WEEK_SLOTS, type BlockField } from '../../store/scheduleDraft.ts';
import { selectSchedule } from '../../store/selectors/schedule.ts';
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx';
import { Button } from '../../ui/Button.tsx';
import { useAnnounce } from '../../ui/LiveRegion.tsx';
import { ServerOption, ServerValue } from '../../ui/ServerValue.tsx';
import { pageHref } from '../../ui/routes.ts';
import { Why } from '../../ui/Why.tsx';
import { TopBar } from '../dashboard/topBar/TopBar.tsx';
import './schedule.css';

function fieldId(key: string, field: string): string {
  return `schedule:${encodeURIComponent(key)}:${field}`;
}

/** F6-11 RL8: draft a first plan for a profile without one; Save schedule sends it. */
function StartPlan({
  runs,
  onStart,
}: {
  readonly runs: readonly { readonly key: string; readonly label: ServerText<'name'> | null }[];
  readonly onStart: (run: string) => void;
}) {
  const [picked, setPicked] = useState('');
  const named = runs.filter((run) => run.label !== null);
  const run = named.some((item) => item.key === picked) ? picked : (named[0]?.key ?? '');
  if (named.length === 0) return <p>{t.startNoRun.short}</p>;
  return (
    <div className="tp-schedule__start">
      <label className="tp-schedule__run">
        <span>{t.startRun.short}</span>
        <select
          id="schedule:start-run"
          value={run}
          onChange={(event) => {
            setPicked(event.currentTarget.value);
          }}
        >
          {named.map((item) =>
            item.label === null ? null : (
              <ServerOption key={item.key} value={item.key} label={item.label} />
            ),
          )}
        </select>
      </label>
      <Button
        tier="primary"
        id="schedule:start"
        label={t.startPlan.short}
        onClick={() => {
          onStart(run);
        }}
      />
      <Why why={t.startPlan.why} />
    </div>
  );
}
export function SchedulePage({ schedule }: { readonly schedule: ScheduleStore }) {
  const state = useSyncExternalStore(schedule.subscribe, schedule.getSnapshot);
  const [now, setNow] = useState(Date.now);
  const [discardTarget, setDiscardTarget] = useState<{
    readonly key: string | null;
    readonly epoch: number;
  } | null>(null);
  const [focusRequest, setFocusRequest] = useState<{
    readonly id: string;
    readonly serial: number;
  } | null>(null);
  const focus = (id: string) => {
    setFocusRequest((previous) => ({ id, serial: (previous?.serial ?? 0) + 1 }));
  };
  const vm = selectSchedule(state, now);
  const entry = vm.entry;
  const announce = useAnnounce();
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  useLayoutEffect(() => {
    const remembered = currentSchedule(schedule.getSnapshot())?.focus;
    if (remembered) document.getElementById(remembered)?.focus();
  }, [schedule, state.key, entry?.day, vm.hasDraftPlan]);
  useLayoutEffect(() => {
    if (focusRequest !== null) document.getElementById(focusRequest.id)?.focus();
  }, [focusRequest]);
  return (
    <>
      <header className="tp-topbar">
        <TopBar title={t.pageName.short} readOnly />
      </header>
      <main
        id="main"
        className="tp-main tp-schedule"
        tabIndex={-1}
        onFocusCapture={(event) => {
          if (event.target instanceof HTMLElement && event.target.id.startsWith('schedule:'))
            schedule.rememberFocus(event.target.id);
        }}
      >
        <p>{t.intro.short}</p>
        <p className="tp-schedule__target">
          <strong>{t.target.short}</strong>
          {vm.instance === null ? (
            t.notReported.short
          ) : (
            <ServerValue kind="name" value={vm.instance} />
          )}
          {vm.account === null ? (
            t.notReported.short
          ) : (
            <ServerValue kind="name" value={vm.account} />
          )}
          {vm.profile === null ? (
            t.notReported.short
          ) : (
            <ServerValue kind="name" value={vm.profile} />
          )}
        </p>
        <section aria-labelledby="schedule-observed" className="tp-schedule__observed">
          <h2 id="schedule-observed">{t.observed.short}</h2>
          {vm.observationState === null ? null : <p>{t[vm.observationState].short}</p>}
          {vm.winner === null ? null : (
            <p>
              <ServerValue kind="name" value={vm.winner} />
            </p>
          )}
          {vm.previousWinner === null ? null : (
            <p>
              {t.previousWinner.short}
              <ServerValue kind="name" value={vm.previousWinner} />
            </p>
          )}
          <div className="tp-schedule__facts">
            <span>
              {t.timezone.short}
              {t.space}
              {vm.timezone === null ? (
                t.notReported.short
              ) : (
                <ServerValue kind="detail" value={vm.timezone} />
              )}
              {t.space}
              {vm.offset === null ? null : <ServerValue kind="detail" value={vm.offset} />}
            </span>
            <span>
              {t.observedAt.short} {vm.observedAt ?? t.notReported.short}
            </span>
            <span>
              {vm.nextCheck === null ? (
                t.noCheck.short
              ) : (
                <>
                  {t.nextCheck.short} <ServerValue kind="detail" value={vm.nextCheck} />
                </>
              )}
            </span>
          </div>
          {vm.reason === null ? null : (
            <p>
              {t.observedReason.short} <ServerValue kind="message" value={vm.reason} />
            </p>
          )}
          <p>{t.handoff.short}</p>
        </section>
        <button
          type="button"
          className="tp-button"
          id="schedule:read"
          disabled={entry?.busy === true}
          onClick={() => {
            void schedule.refresh();
          }}
        >
          {t.refresh.short}
        </button>
        {state.context === null ? (
          <p>{t.unknownTarget.short}</p>
        ) : vm.noProfile ? (
          <p>{t.noProfile.short}</p>
        ) : null}
        {entry?.busy === true ? <p role="status">{t.reading.short}</p> : null}
        {entry?.readError === true ? <p role="alert">{t.readError.short}</p> : null}
        {entry?.source !== undefined && !vm.hasDraftPlan ? <p>{t.missing.short}</p> : null}
        {vm.planMissing ? (
          <StartPlan
            runs={vm.runs}
            onStart={(run) => {
              if (!schedule.start(run)) return;
              announce(t.started.short);
              focus(fieldId(`${FIRST_DAY}:0`, 'block'));
            }}
          />
        ) : null}
        {vm.empty ? <p role="alert">{t.empty.short}</p> : null}
        <p>
          <a id="schedule:profiles" href="/ui/index.html#profiles">
            {t.profiles.short}
          </a>
        </p>
        {vm.hasDraftPlan && entry !== null ? (
          <>
            <div className="tp-schedule__revisions">
              <span>
                {t.savedSource.short}
                {t.space}
                {vm.revision === null ? (
                  t.notReported.short
                ) : (
                  <ServerValue kind="id" value={vm.revision} />
                )}
              </span>
              <span>
                {t.baseRevision.short}
                {t.space}
                {vm.baseRevision === null ? (
                  t.notReported.short
                ) : (
                  <ServerValue kind="id" value={vm.baseRevision} />
                )}
              </span>
            </div>
            {vm.savedPlan === null ? null : (
              <details className="tp-schedule__compare">
                <summary>{t.compare.short}</summary>
                <pre>
                  <ServerValue kind="detail" value={vm.savedPlan} />
                </pre>
              </details>
            )}
            <p>{t.priority.short}</p>
            <nav aria-label={t.days.short} className="tp-schedule__days">
              {vm.dayNames.map((day) => (
                <button
                  key={day.key}
                  type="button"
                  className="tp-button"
                  aria-pressed={entry.day === day.key}
                  onClick={() => {
                    schedule.selectDay(day.key);
                  }}
                >
                  {day.label === null ? (
                    t.dayPlan.short
                  ) : (
                    <ServerValue kind="name" value={day.label} />
                  )}
                </button>
              ))}
            </nav>
            <p>{t.blankTimes.short}</p>
            <div className="tp-schedule__blocks">
              {vm.blocks.map((block) => (
                <fieldset key={block.key} className="tp-schedule__block" data-block-key={block.key}>
                  <legend>{t.block(block.index + 1)}</legend>
                  <label className="tp-schedule__run">
                    <span>{t.run.short}</span>
                    <select
                      id={fieldId(block.key, 'blueprint')}
                      value={block.blueprint}
                      aria-invalid={block.invalid.blueprint || undefined}
                      aria-describedby={block.invalid.blueprint ? 'schedule-errors' : undefined}
                      onChange={(event) => {
                        schedule.edit(block.key, 'blueprint', event.currentTarget.value);
                      }}
                    >
                      {!vm.runs.some((run) => run.key === block.blueprint) ? (
                        <option value={block.blueprint}>{t.notReported.short}</option>
                      ) : null}
                      {vm.runs.map((run) =>
                        run.label === null ? null : (
                          <ServerOption key={run.key} value={run.key} label={run.label} />
                        ),
                      )}
                    </select>
                  </label>
                  {(['block', 'after', 'until', 'count'] satisfies readonly BlockField[]).map(
                    (field) => (
                      <label key={field}>
                        <span>
                          {field === 'block'
                            ? t.kind.short
                            : field === 'after'
                              ? t.after.short
                              : field === 'until'
                                ? t.until.short
                                : t.count.short}
                        </span>
                        <input
                          id={fieldId(block.key, field)}
                          type="text"
                          inputMode={field === 'count' ? 'decimal' : 'text'}
                          value={block[field]}
                          aria-invalid={block.invalid[field] || undefined}
                          aria-describedby={
                            vm.outcome === 'refused' ? 'schedule-errors' : undefined
                          }
                          onChange={(event) => {
                            schedule.edit(block.key, field, event.currentTarget.value);
                          }}
                        />
                      </label>
                    ),
                  )}
                  <div className="tp-schedule__actions">
                    <button
                      type="button"
                      className="tp-button"
                      disabled={block.index === 0}
                      onClick={() => {
                        const position = schedule.move(block.key, -1);
                        if (position !== null) announce(t.moved(position));
                        focus(fieldId(block.key, 'blueprint'));
                      }}
                    >
                      {t.up.short}
                    </button>
                    <button
                      type="button"
                      className="tp-button"
                      disabled={block.index === vm.blocks.length - 1}
                      onClick={() => {
                        const position = schedule.move(block.key, 1);
                        if (position !== null) announce(t.moved(position));
                        focus(fieldId(block.key, 'blueprint'));
                      }}
                    >
                      {t.down.short}
                    </button>
                    <button
                      type="button"
                      className="tp-button"
                      onClick={() => {
                        const key = schedule.remove(block.key);
                        announce(t.deleted.short);
                        focus(key === null ? 'schedule:add' : fieldId(key, 'blueprint'));
                      }}
                    >
                      {t.remove.short}
                    </button>
                    <a
                      id={fieldId(block.key, 'runs')}
                      href={pageHref('runs', { kind: 'saved', run: block.blueprint })}
                    >
                      {t.editRun.short}
                    </a>
                  </div>
                  <p className="tp-schedule__quota">
                    <span>{t.quota.short}</span>
                    <span>{t.nextStart.short}</span>
                  </p>
                </fieldset>
              ))}
            </div>
            {vm.blocks.length === 0 ? <p role="alert">{t.noBlocks.short}</p> : null}
            <button
              type="button"
              className="tp-button"
              id="schedule:add"
              disabled={!vm.canAdd}
              aria-describedby="schedule:add-reason"
              onClick={() => {
                const key = schedule.add();
                if (key !== null) {
                  announce(t.added.short);
                  focus(fieldId(key, 'blueprint'));
                }
              }}
            >
              {t.add.short}
            </button>
            <p id="schedule:add-reason">{vm.canAdd ? t.addHint.short : t.addUnavailable.short}</p>
            <details className="tp-schedule__week">
              <summary>{t.week.short}</summary>
              <p>{t.weekHint.short}</p>
              <div className="tp-schedule__week-grid">
                {WEEK_SLOTS.map((slot) => (
                  <label key={slot}>
                    <span>{t.weekLabels[slot].short}</span>
                    <input
                      id={`schedule:week:${slot}`}
                      list="schedule-day-options"
                      type="text"
                      value={entry.draft?.week[slot] ?? ''}
                      aria-invalid={vm.invalidWeek[slot] || undefined}
                      aria-describedby={vm.invalidWeek[slot] ? 'schedule-errors' : undefined}
                      placeholder={slot === 'default' ? t.defaultRequired.short : t.inherited.short}
                      onChange={(event) => {
                        schedule.mapWeek(slot, event.currentTarget.value);
                      }}
                    />
                  </label>
                ))}
              </div>
              <datalist id="schedule-day-options">
                {vm.dayNames.map((day) => (
                  <option key={day.key} value={day.key} />
                ))}
              </datalist>
            </details>
            <section
              aria-label={t.validation.short}
              className="tp-schedule__errors"
              role={vm.outcome === 'refused' ? 'alert' : 'status'}
            >
              <div id="schedule-errors">
                {vm.outcome === null ? null : <p>{t[vm.outcome].short}</p>}
                {vm.error === null ? null : (
                  <p>
                    <ServerValue kind="message" value={vm.error} />
                  </p>
                )}
                {vm.problems.map((problem, index) => (
                  <p key={index}>
                    <ServerValue kind="message" value={problem} />
                  </p>
                ))}
              </div>
            </section>
            {vm.warnings.length === 0 ? null : (
              <section aria-label={t.warnings.short} className="tp-schedule__errors">
                <h3>{t.warnings.short}</h3>
                {vm.warnings.map((warning, index) => (
                  <p key={index}>
                    <ServerValue kind="message" value={warning} />
                  </p>
                ))}
              </section>
            )}
            {entry.reconcile || vm.partial ? (
              <div className="tp-schedule__errors">
                <p id="schedule:reconcile-reason">{t.reconcileHint.short}</p>
                <button
                  type="button"
                  className="tp-button"
                  disabled={!entry.checked || entry.busy || entry.intent?.phase === 'sending'}
                  onClick={schedule.reconcile}
                >
                  {t.reconcile.short}
                </button>
              </div>
            ) : null}
            <div className="tp-schedule__save">
              <strong>{entry.dirty ? t.dirty.short : t.clean.short}</strong>
              <span>{t.scope.short}</span>
              <Button
                id="schedule:save"
                tier="secondary"
                label={t.save.short}
                busy={entry.intent?.phase === 'sending'}
                {...(!vm.canSave ? { disabled: true, reasonId: 'schedule:save-reason' } : {})}
                onClick={schedule.save}
              />
              <Button
                id="schedule:discard"
                tier="quiet"
                label={t.discard.short}
                {...(!entry.dirty || vm.pending
                  ? { disabled: true, reasonId: 'schedule:save-reason' }
                  : {})}
                onClick={() => {
                  const target = schedule.getSnapshot();
                  setDiscardTarget({ key: target.key, epoch: target.epoch });
                }}
              />
              {!vm.canSave ? (
                <p id="schedule:save-reason">{t.saveUnavailable[vm.saveUnavailable].short}</p>
              ) : null}
            </div>
          </>
        ) : null}
        <ConfirmDialog
          open={
            discardTarget !== null &&
            discardTarget.key === state.key &&
            discardTarget.epoch === state.epoch
          }
          title={t.discardTitle.short}
          body={t.discardBody.short}
          confirmLabel={t.discard.short}
          cancelLabel={t.cancel.short}
          tier="primary"
          onCancel={() => {
            setDiscardTarget(null);
          }}
          onConfirm={() => {
            const target = schedule.getSnapshot();
            if (discardTarget?.key === target.key && discardTarget.epoch === target.epoch)
              schedule.discard();
            setDiscardTarget(null);
          }}
        />
      </main>
    </>
  );
}
