import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { copy } from '../../../copy/catalogue.ts';
import { ageAgo, lastRead } from '../../../copy/dashboard/shell.ts';
import type { CopyEntry } from '../../../copy/text.ts';
import type { ServerText } from '../../../copy/server.ts';
import {
  selectThisBattle,
  type BattleCommandVM,
  type QueueVM,
  type RoutineRowVM,
  type ThisBattleVM,
  type ShoppingTryOnceVM,
} from '../../../store/selectors/thisBattle.ts';
import type { ChipVM } from '../../../store/viewModels.ts';
import { Button } from '../../../ui/Button.tsx';
import { Chip } from '../../../ui/Chip.tsx';
import { Disclosure } from '../../../ui/Disclosure.tsx';
import { Notice } from '../../../ui/Notice.tsx';
import { useAnnounce } from '../../../ui/LiveRegion.tsx';
import { RegionBody, RegionEnd, RegionInline } from '../../../ui/Region.tsx';
import { pageHref } from '../../../ui/routes.ts';
import { ServerValue } from '../../../ui/ServerValue.tsx';
import { Why } from '../../../ui/Why.tsx';
import { useDashboard, useView } from '../context.ts';
import { DashboardRegion } from '../shared/DashboardRegion.tsx';
import './thisBattle.css';
import '../../runs/shoppingLive.css';

const words = copy.dashboard.thisBattle;
function lookup(
  entries: Readonly<Record<string, CopyEntry>>,
  code: string,
  fallback: CopyEntry,
): CopyEntry {
  return Object.hasOwn(entries, code) ? (entries[code] ?? fallback) : fallback;
}

/**
 * F-055: "the blocker word": a routine's blocker is a code the runtime
 * publishes; known codes read as words, any other reads "blocked" with the
 * code as sent under Why.
 */
function Blocker({ code }: { readonly code: ServerText<'message'> }) {
  const known: Readonly<Record<string, CopyEntry>> = words.blockers;
  if (Object.hasOwn(known, code))
    return <span>{lookup(known, code, words.blockers.other).short}</span>;
  return (
    <span>
      {words.blockers.other.short}
      <Disclosure label={copy.common.why.short}>
        <ServerValue value={code} kind="message" />
      </Disclosure>
    </span>
  );
}

function Decision({ value }: { readonly value: ChipVM }) {
  return (
    <>
      {value.word === null ? null : <Chip state={value.word} />}
      <span>{lookup(words.lines, value.line, words.unknown).short}</span>
    </>
  );
}

function outcomeEntry(outcome: ThisBattleVM['outcomes'][number]): CopyEntry {
  if (outcome.command !== null) return lookup(words.lines, outcome.command.line, words.unknown);
  if (outcome.settledByRead !== null) return words.recorded;
  if (outcome.phase === 'sending') return copy.dashboard.shell.sending;
  return outcome.outcome === 'not_recorded' ? words.refused : words.outcomeUnknown;
}

/** RUN-12: the live editor and the battle run's saved settings, on the new Runs page. */
function ScopedLinks({ run }: { readonly run: ServerText<'name'> | null }) {
  const { runKey } = useView(selectThisBattle);
  return (
    <div className="tp-battle__links">
      <a href={pageHref('runs', { kind: 'live' })} data-focus-key="battle-edit">
        {words.actions.edit.short}
      </a>
      <a
        href={pageHref('runs', runKey === null ? null : { kind: 'saved', run: runKey })}
        data-focus-key="battle-saved"
      >
        {words.actions.saved.short}
      </a>
      {run === null ? (
        <span>{words.runUnknown.short}</span>
      ) : (
        <ServerValue value={run} kind="name" />
      )}
    </div>
  );
}

function Result({ row, queue }: { readonly row: RoutineRowVM; readonly queue: QueueVM | null }) {
  return (
    <div className="tp-battle__result">
      <Decision value={row.result.chip} />
      {row.resultAgeSec === null ? null : (
        <span>
          {words.separator.short}
          {ageAgo(row.resultAgeSec)}
        </span>
      )}
      {row.result.confirmedPurchases === null ? null : (
        <span>{words.purchases(row.result.confirmedPurchases)}</span>
      )}
      {row.result.reason === null ? null : (
        <Disclosure label={copy.common.why.short}>
          <ServerValue value={row.result.reason} kind="message" />
        </Disclosure>
      )}
      {queue === null ? null : <ShoppingDecision value={queue} />}
    </div>
  );
}

function RoutineRow({
  row,
  queue,
  run,
  battleKey,
}: {
  readonly row: RoutineRowVM;
  readonly queue: QueueVM | null;
  readonly run: ServerText<'name'> | null;
  readonly battleKey: string;
}) {
  const { commands } = useDashboard();
  const reason = lookup(
    words.disabled,
    row.runNow.reason ?? 'report_unavailable',
    words.disabled.report_unavailable,
  );
  const nameId = `battle-${row.routine}-name`;
  const reasonId = `battle-${row.routine}-reason`;
  const unsupported = row.runNow.reason === 'action_unsupported';
  return (
    <li className="tp-battle__routine">
      <strong className="tp-battle__name" id={nameId}>
        {words.routines[row.routine].short}
      </strong>
      <div className="tp-battle__setting">
        <span className="tp-battle__column-label">{words.columns.battle.short}</span>
        {unsupported ? (
          words.disabled.action_unsupported.short
        ) : row.timing.row === 'F-050' ? (
          <Decision value={row.timing} />
        ) : row.savedEnabled === null ? (
          words.unknown.short
        ) : row.savedEnabled ? (
          words.on.short
        ) : (
          words.off.short
        )}
        {!unsupported && row.savedIntervalSec !== null ? (
          <span>{words.every(row.savedIntervalSec)}</span>
        ) : null}
      </div>
      <div className="tp-battle__next">
        <span className="tp-battle__column-label">{words.columns.next.short}</span>
        {unsupported || row.timing.row === 'F-050' ? (
          words.dash.short
        ) : row.timing.line === 'paused_until_window' && row.windowEndsAt !== null ? (
          words.paused(row.windowEndsAt)
        ) : row.timing.line === 'routine_blocker' && row.blocker !== null ? (
          <Blocker code={row.blocker} />
        ) : row.nextInSec !== null ? (
          words.next(row.nextInSec)
        ) : row.timing.line === 'routine_reported' && row.stateCode !== null ? (
          lookup(words.states, row.stateCode, words.unknown).short
        ) : (
          <Decision value={row.timing} />
        )}
      </div>
      <div className="tp-battle__last">
        <span className="tp-battle__column-label">{words.columns.result.short}</span>
        <Result row={row} queue={queue} />
      </div>
      <div className="tp-battle__action">
        {/* Name = visible label + target ("Run now Ad gems"): WCAG 2.5.3 label in name, axe label-content-name-mismatch. */}
        <button
          type="button"
          className="tp-button"
          data-tier="secondary"
          data-focus-key={`run-now-${row.routine}`}
          aria-labelledby={`${nameId}-run ${nameId}-now ${nameId}`}
          aria-disabled={row.runNow.enabled ? undefined : true}
          aria-describedby={row.runNow.enabled ? undefined : reasonId}
          onClick={() => {
            if (row.runNow.enabled && row.runNow.command !== null)
              void commands.runNow(row.runNow.command);
          }}
        >
          <span id={`${nameId}-run`}>{words.run.short}</span>
          <span id={`${nameId}-now`}>{words.now.short}</span>
        </button>
      </div>
      {row.runNow.enabled ? null : (
        <div id={reasonId} className="tp-battle__reason">
          {reason.short}
          <Why why={reason.why} />
        </div>
      )}
      {queue === null ? null : <Queue key={battleKey} value={queue} run={run} />}
    </li>
  );
}

function ShoppingTryOnceAction({ item }: { readonly item: ShoppingTryOnceVM }) {
  const { commands } = useDashboard();
  const id = `shopping-try-${item.action}`;
  return (
    <div className="tp-shopping-try__action">
      <button
        type="button"
        className="tp-button"
        aria-labelledby={`${id}-label ${id}-target`}
        aria-disabled={item.button.enabled ? undefined : true}
        aria-describedby={item.button.enabled ? undefined : `${id}-reason`}
        onClick={() => {
          if (item.button.enabled && item.button.command !== null)
            void commands.runNow(item.button.command);
        }}
      >
        <span id={`${id}-label`}>{words.tryOnce.short}</span>
      </button>
      {item.button.enabled ? null : (
        <div id={`${id}-reason`}>
          {
            lookup(
              words.disabled,
              item.button.reason ?? 'report_unavailable',
              words.disabled.report_unavailable,
            ).short
          }
        </div>
      )}
    </div>
  );
}

function ShoppingTryOnce({ value }: { readonly value: readonly ShoppingTryOnceVM[] }) {
  return (
    <div className="tp-shopping-try">
      <p>{words.tryNotice.short}</p>
      {value.map((item) => (
        <div key={item.action}>
          <span id={`shopping-try-${item.action}-target`}>
            {item.known === null ? (
              item.label === null ? (
                words.queue.unknownUpgrade.short
              ) : (
                <ServerValue kind="name" value={item.label} />
              )
            ) : (
              words.tryTargets[item.known].short
            )}
          </span>
          <ShoppingTryOnceAction item={item} />
        </div>
      ))}
    </div>
  );
}

function Queue({
  value,
  run,
}: {
  readonly value: QueueVM;
  readonly run: ServerText<'name'> | null;
}) {
  const { tryOnce } = useView(selectThisBattle);
  return (
    <div className="tp-battle__queue">
      <ShoppingTryOnce value={tryOnce.filter((item) => item.known !== null)} />
      {value.warnings.map((warning) => {
        const entry = lookup(
          {
            reserve_not_protected: words.queue.reserve_not_protected,
            purchase_quantity_unverified: words.queue.purchase_quantity_unverified,
          },
          warning.line,
          words.unknown,
        );
        return (
          <Notice
            key={warning.line}
            state={warning.word ?? 'unknown'}
            line={entry.short}
            {...(entry.why === undefined ? {} : { why: entry.why })}
            actions={warning.line === 'reserve_not_protected' ? <ScopedLinks run={run} /> : null}
          />
        );
      })}
      <Disclosure
        label={words.queue.title.short}
        count={value.items.length}
        focusKey="battle-queue"
        preview={
          <>
            {value.items.slice(0, 3).map((item) => (
              <span key={item.key}>
                {item.label === null ? (
                  words.queue.unknownUpgrade.short
                ) : (
                  <ServerValue value={item.label} kind="name" />
                )}
              </span>
            ))}
          </>
        }
      >
        <p>{words.queue.scope.short}</p>
        {value.needsReview ? (
          <p>{words.queue.review.short}</p>
        ) : (
          <>
            <p>{lookup(words.queue.rules, value.mode ?? '', words.queue.unknownRule).short}</p>
            <p>
              {lookup(words.queue.cadence, value.cadence ?? '', words.queue.cadenceUnknown).short}
            </p>
            <p>
              {value.reserve === null ? words.queue.noReserve.short : words.reserve(value.reserve)}
            </p>
          </>
        )}
        {value.items.length === 0 ? (
          <p>{words.queue.empty.short}</p>
        ) : (
          <ol>
            {value.items.map((item) => (
              <li key={item.key}>
                <div className="tp-battle__queue-entry">
                  <span
                    id={
                      item.tryOnce === null
                        ? undefined
                        : `shopping-try-${item.tryOnce.action}-target`
                    }
                  >
                    {item.label === null ? (
                      words.queue.unknownUpgrade.short
                    ) : (
                      <ServerValue value={item.label} kind="name" />
                    )}
                  </span>
                  {item.enabled ? null : <span>{words.queue.disabled.short}</span>}
                  <span>
                    {item.tapLimit === null ? words.queue.noCap.short : words.tapCap(item.tapLimit)}
                  </span>
                  {value.mode === 'weighted_split' && item.weight !== null ? (
                    <span>{words.weight(item.weight)}</span>
                  ) : null}
                  {item.tryOnce === null ? null : <ShoppingTryOnceAction item={item.tryOnce} />}
                </div>
              </li>
            ))}
          </ol>
        )}
        <ScopedLinks run={run} />
      </Disclosure>
    </div>
  );
}

function ShoppingDecision({ value }: { readonly value: QueueVM }) {
  return (
    <Disclosure label={copy.common.why.short} focusKey="shopping-decision">
      {value.reportedAgeSec === null ? null : <p>{words.reported(value.reportedAgeSec)}</p>}
      <p>{words.queue.decision.short}</p>
      {value.decision === null ? null : <ServerValue value={value.decision} kind="detail" />}
      {value.decisionReason === null ? null : (
        <ServerValue value={value.decisionReason} kind="message" />
      )}
      {value.decisionUpgrade === null ? null : (
        <ServerValue value={value.decisionUpgrade} kind="name" />
      )}
      {value.pendingUpgrade === null ? null : (
        <ServerValue label={words.queue.pending.short} value={value.pendingUpgrade} kind="name" />
      )}
      <p>{words.queue.confirmation.short}</p>
      {value.confirmationUpgrade === null ? null : (
        <ServerValue value={value.confirmationUpgrade} kind="name" />
      )}
      {value.confirmationOutcome === null ? null : (
        <ServerValue value={value.confirmationOutcome} kind="detail" />
      )}
      {value.confirmationReason === null ? null : (
        <ServerValue value={value.confirmationReason} kind="message" />
      )}
    </Disclosure>
  );
}

function CommandRow({ value }: { readonly value: BattleCommandVM }) {
  return (
    <li className="tp-battle__command">
      <Decision value={value} />
      {value.shoppingState === null ? null : (
        <span>{words.shoppingStates[value.shoppingState].short}</span>
      )}
      {value.actionText === null ? null : <ServerValue kind="id" value={value.actionText} />}
      {value.serverEvidence === null ? null : (
        <Disclosure label={words.commandEvidence.short}>
          <ServerValue kind="detail" value={value.serverEvidence} />
        </Disclosure>
      )}
      {value.row === 'K4' && value.resultChip !== null ? (
        <Decision value={value.resultChip} />
      ) : null}
      {value.resultAgeSec === null ? null : <span>{ageAgo(value.resultAgeSec)}</span>}
      {value.row === 'K4' && value.result.confirmedPurchases !== null ? (
        <span>{words.purchases(value.result.confirmedPurchases)}</span>
      ) : null}
      {value.reason === null && value.result.reason === null ? null : (
        <Disclosure label={copy.common.why.short}>
          {value.reason === null ? null : <ServerValue value={value.reason} kind="message" />}
          {value.result.reason === null ? null : (
            <ServerValue value={value.result.reason} kind="message" />
          )}
        </Disclosure>
      )}
    </li>
  );
}

function BattleContent() {
  const vm = useView(selectThisBattle);
  const { commands } = useDashboard();
  const announce = useAnnounce();
  const previousWord = useRef(vm.header.word);
  const announcedOutcomes = useRef(new Map<string, string>());
  const [dismissed, setDismissed] = useState(0);
  const outcomeArea = useRef<HTMLDivElement>(null);
  const focused = useRef<HTMLElement | null>(null);
  const neighbours = useRef<HTMLElement[]>([]);
  useEffect(() => {
    if (previousWord.current !== vm.header.word && vm.header.word !== null)
      announce(copy.states[vm.header.word].short);
    previousWord.current = vm.header.word;
  }, [announce, vm.header.word]);
  useEffect(() => {
    for (const outcome of vm.outcomes) {
      if (outcome.phase === 'sending') continue;
      const signature = `${outcome.phase}:${outcome.outcome}:${outcome.settledByRead ?? ''}:${outcome.command?.line ?? ''}`;
      if (announcedOutcomes.current.get(outcome.id) === signature) continue;
      announcedOutcomes.current.set(outcome.id, signature);
      announce(outcomeEntry(outcome).short);
    }
  }, [announce, vm.outcomes]);
  useEffect(() => {
    if (dismissed === 0) return undefined;
    const timeout = window.setTimeout(() => {
      setDismissed(0);
    }, 8000);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [dismissed]);
  useLayoutEffect(() => {
    if (focused.current !== null && !focused.current.isConnected) {
      (
        neighbours.current.find((target) => target.isConnected) ??
        document.getElementById('thisBattle-title')
      )?.focus();
      focused.current = null;
    }
  }, [vm.outcomes, vm.noTrackedBattle]);
  if (vm.noTrackedBattle)
    return (
      // F4-02: an empty region is one line beside its title.
      <RegionInline>
        <span>{words.noTracked.short}</span>
        <Why why={words.noTracked.why} />
      </RegionInline>
    );
  return (
    <>
      <RegionEnd>
        <div className="tp-battle__header">
          <span>
            {vm.label === null ? (
              words.runUnknown.short
            ) : (
              <ServerValue value={vm.label} kind="name" />
            )}
            {words.separator.short}
            {vm.wave === null ? words.waveUnknown.short : words.wave(vm.wave)}
            {words.separator.short}
            {words.scope.short}
          </span>
          <span>
            {vm.header.word === null ? null : <Chip state={vm.header.word} />}
            {vm.header.row === 'B7' && vm.reportAgeSec !== null
              ? words.oldReport(vm.reportAgeSec)
              : lookup(words.lines, vm.header.line, words.unknown).short}
            {vm.header.row === 'B1' && vm.readAgeSec !== null ? (
              <span>{lastRead(vm.readAgeSec)}</span>
            ) : null}
            {(vm.header.row === 'B5' || vm.header.row === 'B6') && vm.reportAgeSec !== null ? (
              <span>{words.reported(vm.reportAgeSec)}</span>
            ) : null}
          </span>
        </div>
      </RegionEnd>
      <RegionBody>
        {vm.changed ? (
          <div>
            {words.changed.short}
            <ScopedLinks run={vm.label} />
          </div>
        ) : null}
        {vm.routines.length === 0 ? null : (
          // F4-02, spec 2.2 sketch: the column labels once, on wide layouts; each cell keeps
          // its own label for screen readers and for the narrow layout.
          <div className="tp-battle__columns" aria-hidden="true">
            <span>{words.columns.routine.short}</span>
            <span>{words.columns.battle.short}</span>
            <span>{words.columns.next.short}</span>
            <span>{words.columns.result.short}</span>
            <span>{words.columns.action.short}</span>
          </div>
        )}
        <ul className="tp-rows tp-battle__routines">
          {vm.routines.map((row) => (
            <RoutineRow
              key={row.routine}
              row={row}
              queue={row.routine === 'shopping' ? vm.queue : null}
              run={vm.label}
              battleKey={vm.battleKey}
            />
          ))}
        </ul>
        <ul className="tp-rows">
          {vm.commands.map((command) => (
            <CommandRow key={command.key} value={command} />
          ))}
        </ul>
        <ul className="tp-rows">
          {vm.outcomes
            .filter(
              (outcome) =>
                outcome.command !== null &&
                !vm.commands.some((command) => command.key === outcome.command?.key),
            )
            .map((outcome) =>
              outcome.command === null ? null : (
                <CommandRow key={outcome.id} value={outcome.command} />
              ),
            )}
        </ul>
        <div
          ref={outcomeArea}
          onFocusCapture={(event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            focused.current = target;
            const rows = Array.from(
              outcomeArea.current?.querySelectorAll<HTMLElement>('[data-battle-outcome]') ?? [],
            );
            const index = rows.findIndex((row) => row.contains(target));
            neighbours.current = [
              ...rows.slice(index + 1),
              ...rows.slice(0, index).reverse(),
            ].flatMap((row) => {
              const first = row.querySelector<HTMLElement>('button, summary, a[href]');
              return first === null ? [] : [first];
            });
          }}
          onBlurCapture={(event) => {
            if (
              event.relatedTarget instanceof Node &&
              !event.currentTarget.contains(event.relatedTarget)
            )
              focused.current = null;
          }}
        >
          {vm.outcomes
            .filter((outcome) => outcome.settledByRead === null && outcome.command === null)
            .map((outcome) => {
              const entry = outcomeEntry(outcome);
              return (
                <div key={outcome.id} data-battle-outcome={outcome.id}>
                  <Notice
                    state={
                      outcome.phase === 'sending'
                        ? 'waiting'
                        : outcome.outcome === 'not_recorded'
                          ? 'failed'
                          : 'unknown'
                    }
                    line={entry.short}
                    {...(entry.why === undefined ? {} : { why: entry.why })}
                    server={
                      outcome.error === null ? null : (
                        <ServerValue value={outcome.error} kind="message" />
                      )
                    }
                    actions={
                      <>
                        <Button
                          tier="quiet"
                          label={copy.shoppingLive.check.short}
                          onClick={commands.checkBattle}
                        />
                        {outcome.resendOffered ? (
                          <>
                            <Button
                              tier="secondary"
                              label={words.actions.resend.short}
                              {...(vm.resendAvailable
                                ? {}
                                : { disabled: true, reasonId: `resend-${outcome.id}-reason` })}
                              onClick={() => {
                                void commands.resend(outcome.id);
                              }}
                            />
                            {vm.resendAvailable ? null : (
                              <span id={`resend-${outcome.id}-reason`}>
                                {words.resendUnavailable.short}
                              </span>
                            )}
                          </>
                        ) : null}
                        <Button
                          tier="quiet"
                          label={words.actions.dismiss.short}
                          describedBy={`dismiss-${outcome.id}`}
                          onClick={() => {
                            commands.dismiss(outcome.id);
                            setDismissed((count) => count + 1);
                          }}
                        />
                        <span className="tp-battle__sr" id={`dismiss-${outcome.id}`}>
                          {words.dismissDescription.short}
                        </span>
                      </>
                    }
                  />
                </div>
              );
            })}
        </div>
        {dismissed > 0 ? <p>{words.dismissed.short}</p> : null}
      </RegionBody>
    </>
  );
}

/** Region 'thisBattle' (spec 2.1): owned by its region author. */
export function ThisBattle() {
  return (
    <DashboardRegion id="thisBattle">
      <BattleContent />
    </DashboardRegion>
  );
}
