import { useEffect, useId, useState, type ComponentType } from 'react';
import { recognition as t } from '../../copy/recognition.ts';
import type { CopyEntry, CopyNode } from '../../copy/text.ts';
import {
  selectRecognitionPage,
  type EvidenceEntryVM,
  type ReadinessCardVM,
  type RecognitionOutcomeVM,
} from '../../store/selectors/recognition.ts';
import { selectOutcomes } from '../../store/selectors/outcomes.ts';
import type { CommandVM } from '../../store/viewModels.ts';
import { Button } from '../../ui/Button.tsx';
import { Chip } from '../../ui/Chip.tsx';
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx';
import { Disclosure } from '../../ui/Disclosure.tsx';
import { Notice } from '../../ui/Notice.tsx';
import { RegionBoundary } from '../../ui/RegionBoundary.tsx';
import { Region, RegionBody, RegionEnd } from '../../ui/Region.tsx';
import { ServerOption, ServerValue } from '../../ui/ServerValue.tsx';
import { Why } from '../../ui/Why.tsx';
import {
  FaultPoint,
  useDashboard,
  useEpochKey,
  usePartError,
  useView,
} from '../dashboard/context.ts';
import { OwnerNotice } from '../dashboard/outcomes/OwnerNotice.tsx';
import { RevocationFallback } from '../dashboard/shared/RevocationFallback.tsx';
import { TopBar } from '../dashboard/topBar/TopBar.tsx';
import './recognition.css';

/** The requests this page owns; their owner notices are shown here (the shared notice). */
const PAGE_KINDS: readonly string[] = [
  'calibrate_start',
  'calibrate_observe',
  'calibrate_apply',
  'calibrate_stop',
];

function reasonOf(reason: string | null): CopyEntry {
  const reasons: Readonly<Record<string, CopyEntry>> = t.reasons;
  return (reason === null ? undefined : reasons[reason]) ?? t.reasons.context_unknown;
}

function Line({ entry }: { readonly entry: CopyEntry }) {
  return (
    <div className="tp-recognition__line">
      <span>{entry.short}</span>
      {entry.why === undefined ? null : <Why why={entry.why} />}
    </div>
  );
}

/** One action button, the same element whatever its state; disabled with its visible reason. */
function Action<C>({
  vm,
  label,
  focusKey,
  onClick,
  tier = 'secondary',
}: {
  readonly vm: CommandVM<C>;
  readonly label: CopyEntry;
  readonly focusKey: string;
  readonly onClick: (command: C) => void;
  readonly tier?: 'secondary' | 'quiet' | 'halt';
}) {
  const own = useId();
  if (!vm.shown) return null;
  return (
    <span className="tp-recognition__action">
      <Button
        tier={tier}
        label={label.short}
        focusKey={focusKey}
        busy={vm.sending}
        {...(vm.enabled ? {} : { disabled: true as const, reasonId: `${own}-reason` })}
        onClick={() => {
          if (vm.enabled && vm.command !== null) onClick(vm.command);
        }}
      />
      {vm.enabled ? null : (
        <span id={`${own}-reason`} className="tp-reason" data-reason={vm.reason ?? ''}>
          {reasonOf(vm.reason).short}
        </span>
      )}
    </span>
  );
}

function RecognitionRegion({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: CopyEntry;
  readonly children: CopyNode;
}) {
  return (
    <Region
      id={id}
      title={title.short}
      fallback={<RevocationFallback part="recognition" withStops />}
      resetKey={useEpochKey()}
      onError={usePartError(id)}
    >
      <FaultPoint part={id} />
      {children}
    </Region>
  );
}

/** The owner notice of a refused request of this page (the shared, D-4-judged notice). */
function PageOwnerNotice() {
  const vm = useView(selectOutcomes);
  const { commands } = useDashboard();
  const notice = vm.ownerNotice;
  if (notice === null || !PAGE_KINDS.includes(notice.action)) return null;
  return (
    <div className="tp-recognition__owner" data-owner-notice="true">
      <OwnerNotice
        notice={notice}
        onDismiss={() => {
          commands.dismiss(notice.intentId);
        }}
      />
    </div>
  );
}

function NotSent() {
  const vm = useView(selectOutcomes);
  const notice = vm.notices.find((entry) => entry.kind === 'command_not_sent');
  const reasons: Readonly<Record<string, CopyEntry>> = t.reasons;
  const entry = notice === undefined ? undefined : reasons[notice.reason];
  if (notice === undefined || entry === undefined) return null;
  return (
    <div className="tp-recognition__line" data-not-sent={notice.reason} role="status">
      <span>{entry.short}</span>
    </div>
  );
}

function outcomeName(outcome: RecognitionOutcomeVM): CopyEntry {
  const names = t.outcomes.names;
  switch (outcome.kind) {
    case 'calibrate_start':
      return outcome.action === 'basic'
        ? names.basic
        : outcome.action === 'equipped'
          ? names.equipped
          : outcome.action === 'prepare'
            ? names.prepare
            : names.learn;
    case 'calibrate_observe':
      return outcome.action === 'watch' ? names.watch : names.capture;
    case 'calibrate_apply':
      return outcome.action === 'saved' ? names.saved : names.apply;
    case 'calibrate_stop':
      return names.stop;
  }
}

/** The newest request of one target: what it proved, the server's words, and its actions. */
function Outcome({ outcome }: { readonly outcome: RecognitionOutcomeVM }) {
  const { commands } = useDashboard();
  const o = t.outcomes;
  const entry = o.codes[outcome.code];
  const details =
    outcome.refusalCode !== null ||
    outcome.error !== null ||
    outcome.missing.length > 0 ||
    outcome.remaining.length > 0 ||
    outcome.readinessReady !== null ||
    outcome.attemptRefused !== null ||
    outcome.accepted;
  return (
    <div
      className="tp-recognition__outcome"
      data-outcome={outcome.code}
      data-kind={outcome.kind}
      data-intent={outcome.id}
    >
      <Notice
        state={outcome.word}
        lead={
          <>
            <span>{o.lead.short}</span>
            <span>{outcomeName(outcome).short}</span>
            {outcome.answeredAgeSec === null ? null : (
              <span>{o.answeredAgo(outcome.answeredAgeSec)}</span>
            )}
            {outcome.restored ? <span>{o.restored.short}</span> : null}
            {outcome.sends > 1 ? <span>{o.sends(outcome.sends)}</span> : null}
          </>
        }
        line={
          <span className="tp-recognition__outcome-line">
            <span>{entry.short}</span>
            {outcome.operation === null ? null : (
              <ServerValue kind="id" label={o.operation.short} value={outcome.operation} />
            )}
          </span>
        }
        {...(entry.why === undefined ? {} : { why: entry.why })}
        {...(details
          ? {
              server: (
                <>
                  {outcome.refusalCode === null ? null : (
                    <ServerValue kind="id" label={o.code.short} value={outcome.refusalCode} />
                  )}
                  {outcome.currentContext === null ? null : (
                    <span className="tp-recognition__context" data-current-context="true">
                      <span>{o.currentContext.short}</span>
                      {(['instance', 'account', 'profile', 'serial'] as const).map((key) => {
                        const value = outcome.currentContext?.[key] ?? null;
                        return (
                          <span className="tp-recognition__context-field" key={key}>
                            <span>{o.contextFields[key].short}</span>
                            {value === null ? (
                              o.contextUnknown.short
                            ) : (
                              <ServerValue kind="name" value={value} />
                            )}
                          </span>
                        );
                      })}
                    </span>
                  )}
                  {outcome.error === null ? null : (
                    <span data-server-error="true">
                      <span>{o.serverSaid.short}</span>
                      <ServerValue kind="message" value={outcome.error} />
                    </span>
                  )}
                  {outcome.missing.length === 0 ? null : (
                    <span data-missing="true">
                      <span>{o.missing.short}</span>
                      <ul className="tp-recognition__list">
                        {outcome.missing.map((rel) => (
                          <li key={rel}>
                            <ServerValue kind="id" value={rel} />
                          </li>
                        ))}
                      </ul>
                    </span>
                  )}
                  {outcome.remaining.length === 0 ? null : (
                    <span data-remaining="true">
                      <span>{o.remaining.short}</span>
                      <ul className="tp-recognition__list">
                        {outcome.remaining.map((check, index) => (
                          <li key={String(index)}>
                            <ServerValue kind="message" value={check} />
                          </li>
                        ))}
                      </ul>
                    </span>
                  )}
                  {outcome.readinessReady === null ? null : (
                    <span>{(outcome.readinessReady ? o.readyAfter : o.notReadyAfter).short}</span>
                  )}
                  {outcome.attemptRefused === null ? null : (
                    <span data-attempt-refused="true">
                      <span>{o.attemptRefused.short}</span>
                      {outcome.attemptRefused.error === null ? null : (
                        <ServerValue kind="message" value={outcome.attemptRefused.error} />
                      )}
                    </span>
                  )}
                  {outcome.accepted ? <span>{o.acceptedNote.short}</span> : null}
                </>
              ),
            }
          : {})}
        actions={
          <>
            {outcome.resendOffered ? (
              <Button
                tier="secondary"
                label={o.resend.short}
                focusKey={`recognition-outcome:${outcome.id}:resend`}
                onClick={() => {
                  void commands.resend(outcome.id);
                }}
              />
            ) : null}
            {outcome.acceptOffered ? (
              <Button
                tier="quiet"
                label={o.accept.short}
                focusKey={`recognition-outcome:${outcome.id}:accept`}
                onClick={() => {
                  commands.acceptCurrent(outcome.id);
                }}
              />
            ) : null}
            {outcome.dismissOffered ? (
              <Button
                tier="quiet"
                label={o.dismiss.short}
                focusKey={`recognition-outcome:${outcome.id}:dismiss`}
                onClick={() => {
                  commands.dismiss(outcome.id);
                }}
              />
            ) : null}
          </>
        }
      />
    </div>
  );
}

/** R2: this emulator, account and profile, and the calibrator facts every scan depends on. */
function TargetSection() {
  const vm = useView(selectRecognitionPage);
  const { commands } = useDashboard();
  const s = vm.status;
  const c = vm.context;
  return (
    <>
      <RegionEnd>{s.ageSec === null ? null : <span>{t.status.readAgo(s.ageSec)}</span>}</RegionEnd>
      <RegionBody>
        <Line entry={t.intro} />
        <ul className="tp-recognition__facts">
          <li>
            <span>{t.target.instance.short}</span>
            {c?.instance == null ? (
              <span>{t.target.none.short}</span>
            ) : (
              <ServerValue kind="id" value={c.instance} />
            )}
          </li>
          <li>
            <span>{t.target.serial.short}</span>
            {c?.serial == null ? (
              <span>{t.target.none.short}</span>
            ) : (
              <ServerValue kind="id" value={c.serial} />
            )}
          </li>
          <li>
            <span>{t.target.account.short}</span>
            {c?.account == null ? (
              <span>{t.target.none.short}</span>
            ) : (
              <ServerValue kind="id" value={c.account} />
            )}
          </li>
          <li>
            <span>{t.target.profile.short}</span>
            {c?.profile == null ? (
              <span>{t.target.none.short}</span>
            ) : (
              <ServerValue kind="id" value={c.profile} />
            )}
          </li>
        </ul>
        {vm.contextConfirmed ? null : <Line entry={t.target.unconfirmed} />}
        <div className="tp-recognition__facts-block" data-status-read={s.read}>
          {s.stale ? (
            <div data-stale="true">
              <Line entry={t.status.stale} />
            </div>
          ) : null}
          {s.read === 'not_read' ? <Line entry={t.status.notRead} /> : null}
          {s.read === 'unavailable' ? <Line entry={t.status.unavailable} /> : null}
          {s.read === 'ready' ? (
            <Line
              entry={
                s.tapsAllowed === true
                  ? t.status.tapsOn
                  : s.tapsAllowed === false
                    ? t.status.tapsOff
                    : t.status.tapsUnknown
              }
            />
          ) : null}
          {s.restorePending ? (
            <div data-restore-pending="true">
              <Chip state="blocked" />
              <Line entry={t.status.restorePending} />
            </div>
          ) : null}
          {s.running ? <Line entry={t.status.running} /> : null}
          {vm.battle === true ? (
            <div data-battle-tracked="true">
              <Line entry={t.status.battleTracked} />
            </div>
          ) : null}
          {vm.battle === null ? <Line entry={t.status.battleNotRead} /> : null}
        </div>
        <div className="tp-recognition__row">
          <Button
            tier="quiet"
            label={t.status.check.short}
            focusKey="recognition:check"
            onClick={() => {
              commands.checkRecognition();
            }}
          />
        </div>
      </RegionBody>
    </>
  );
}

/** R1, R7: the primary journey, with each consent chosen at the click. */
function LearnSection() {
  const vm = useView(selectRecognitionPage);
  const { commands } = useDashboard();
  const [battle, setBattle] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [asking, setAsking] = useState(false);
  const l = t.learn;
  // A confirmation opened while a launch was allowed closes, sending nothing, once it is not.
  if (asking && !vm.learn.enabled) setAsking(false);
  return (
    <RegionBody>
      <Line entry={l.intro} />
      <fieldset className="tp-recognition__choices">
        <legend>{l.title.short}</legend>
        <label className="tp-recognition__check">
          <input
            type="checkbox"
            checked={battle}
            data-focus-key="recognition:learn:battle"
            onChange={(event) => {
              setBattle(event.currentTarget.checked);
            }}
          />
          <span>{l.battle.short}</span>
        </label>
        <label className="tp-recognition__check">
          <input
            type="checkbox"
            checked={overwrite}
            data-focus-key="recognition:learn:overwrite"
            onChange={(event) => {
              setOverwrite(event.currentTarget.checked);
            }}
          />
          <span>{l.overwrite.short}</span>
        </label>
      </fieldset>
      <div className="tp-recognition__row">
        <Action
          vm={vm.learn}
          label={l.start}
          focusKey="recognition:learn"
          onClick={() => {
            setAsking(true);
          }}
        />
      </div>
      <ConfirmDialog
        open={asking}
        tier="primary"
        title={l.confirm.short}
        body={
          <ul className="tp-recognition__effects" data-effects="learn">
            <li>{l.effects.navigation.short}</li>
            <li data-effect={battle ? 'battle' : 'no-battle'}>
              {(battle ? l.effects.battle : l.effects.noBattle).short}
            </li>
            <li data-effect={overwrite ? 'overwrite' : 'keep'}>
              {(overwrite ? l.effects.overwrite : l.effects.keep).short}
            </li>
            <li>{l.effects.unknownScreen.short}</li>
          </ul>
        }
        confirmLabel={l.send.short}
        cancelLabel={l.cancel.short}
        onCancel={() => {
          setAsking(false);
        }}
        onConfirm={() => {
          setAsking(false);
          const base = vm.learn.command;
          if (!vm.learn.enabled || base === null) return;
          void commands.recognitionLaunch({
            ...base,
            launch: { kind: 'start', plan: { kind: 'learn', battle, overwrite } },
          });
        }}
      />
    </RegionBody>
  );
}

function at(seconds: number | null, words: (seconds: number) => CopyNode): CopyNode {
  return seconds === null ? null : <span>{words(seconds)}</span>;
}

/** R2, R8: where the operation stands, by its own status and step, with its Stop and apply. */
function OperationSection() {
  const vm = useView(selectRecognitionPage);
  const { commands } = useDashboard();
  const [asking, setAsking] = useState<'stop' | 'apply' | 'saved' | null>(null);
  const op = vm.operation;
  const o = t.operation;
  const s = vm.status;
  // A confirmation whose action is no longer offered closes, sending nothing.
  const offered =
    asking === 'stop'
      ? op?.stop.enabled === true
      : asking === 'apply'
        ? op?.apply.enabled === true
        : asking === 'saved'
          ? vm.savedApply?.enabled === true
          : true;
  if (asking !== null && !offered) setAsking(null);
  const stage = op === null ? null : o.stages[op.stage];
  return (
    <>
      <RegionEnd>{op?.word == null ? null : <Chip state={op.word} />}</RegionEnd>
      <RegionBody>
        <PageOwnerNotice />
        {vm.operationUnread === null ? null : (
          <div data-operation-unread="true">
            <Line entry={o.unread} />
            {vm.operationUnread.error === null ? null : (
              <ServerValue kind="message" value={vm.operationUnread.error} />
            )}
          </div>
        )}
        {op === null ? (
          vm.operationUnread === null ? (
            <p>{o.none.short}</p>
          ) : null
        ) : (
          <div className="tp-recognition__operation" data-stage={op.stage} data-source={op.source}>
            {stage === null ? null : <Line entry={stage} />}
            <ul className="tp-recognition__facts">
              <li>
                <span>{o.sources[op.source].short}</span>
              </li>
              {op.id === null ? null : (
                <li>
                  <ServerValue kind="id" label={o.id.short} value={op.id} />
                  {op.revision === null ? null : <span>{o.revision(op.revision)}</span>}
                </li>
              )}
              {op.status === null ? null : (
                <li>
                  <ServerValue kind="id" label={o.status.short} value={op.status} />
                  {op.step === null ? null : (
                    <ServerValue kind="id" label={o.step.short} value={op.step} />
                  )}
                </li>
              )}
              <li>
                {at(op.createdAt, o.created)}
                {at(op.updatedAt, o.updated)}
                {op.workerPid === null ? (
                  <span>{o.noWorker.short}</span>
                ) : (
                  <span>{o.worker(op.workerPid)}</span>
                )}
              </li>
              <li data-request="true">
                <span>{o.request.short}</span>
                {op.request.phases === null ? null : (
                  <ServerValue kind="id" label={o.phases.short} value={op.request.phases} />
                )}
                {op.request.navigation || op.request.bootstrap ? (
                  <span>{o.navigation.short}</span>
                ) : null}
                <span>{(op.request.battle ? o.battle : o.noBattle).short}</span>
                <span>{(op.request.overwrite ? o.overwrite : o.keep).short}</span>
                {op.request.watch === null ? null : <span>{o.watch(op.request.watch)}</span>}
                {op.request.run === null ? null : (
                  <ServerValue kind="id" label={o.forRun.short} value={op.request.run} />
                )}
              </li>
              {op.error === null ? null : (
                <li data-operation-error="true">
                  <span>{o.error.short}</span>
                  {op.error.code === null ? null : <ServerValue kind="id" value={op.error.code} />}
                  {op.error.message === null ? null : (
                    <ServerValue kind="message" value={op.error.message} />
                  )}
                </li>
              )}
              {op.recovery === null ? null : (
                <li>
                  <ServerValue kind="message" label={o.recovery.short} value={op.recovery} />
                </li>
              )}
              {op.applyStatus === null && op.applyError === null ? null : (
                <li data-apply-record="true">
                  <span>{o.applyStatus.short}</span>
                  {op.applyStatus === null ? null : (
                    <ServerValue kind="id" value={op.applyStatus} />
                  )}
                  {op.applyError === null ? null : (
                    <ServerValue kind="message" value={op.applyError} />
                  )}
                </li>
              )}
            </ul>
            <div className="tp-recognition__row">
              <Action
                vm={op.stop}
                tier="halt"
                label={o.stop}
                focusKey="recognition:stop"
                onClick={() => {
                  setAsking('stop');
                }}
              />
              <Action
                vm={op.apply}
                label={o.apply}
                focusKey="recognition:apply"
                onClick={() => {
                  setAsking('apply');
                }}
              />
            </div>
          </div>
        )}
        {vm.savedApply === null ? null : (
          <div className="tp-recognition__row" data-saved-observations="true">
            <Line entry={o.applySavedNote} />
            <Action
              vm={vm.savedApply}
              label={o.applySaved}
              focusKey="recognition:apply:saved"
              onClick={() => {
                setAsking('saved');
              }}
            />
          </div>
        )}
        <Timeline />
        {vm.outcomes.length === 0 ? null : (
          <div className="tp-recognition__outcomes" aria-label={t.outcomes.title.short}>
            {vm.outcomes.map((outcome) => (
              <Outcome key={outcome.id} outcome={outcome} />
            ))}
          </div>
        )}
        <ConfirmDialog
          open={asking === 'stop'}
          tier="halt"
          title={o.stopConfirm.short}
          body={<p>{o.stopEffects.short}</p>}
          confirmLabel={o.stopSend.short}
          cancelLabel={o.cancel.short}
          onCancel={() => {
            setAsking(null);
          }}
          onConfirm={() => {
            setAsking(null);
            const command = op?.stop.command;
            if (op?.stop.enabled === true && command != null)
              void commands.recognitionStop(command);
          }}
        />
        <ConfirmDialog
          open={asking === 'apply' || asking === 'saved'}
          tier="primary"
          title={o.applyConfirm.short}
          body={<p>{o.applyEffects.short}</p>}
          confirmLabel={o.applySend.short}
          cancelLabel={o.cancel.short}
          onCancel={() => {
            setAsking(null);
          }}
          onConfirm={() => {
            const which = asking;
            setAsking(null);
            const offer = which === 'saved' ? vm.savedApply : (op?.apply ?? null);
            if (offer?.enabled === true && offer.command !== null)
              void commands.recognitionApply(offer.command);
          }}
        />
        {s.restorePending && op === null ? <Line entry={t.status.restorePending} /> : null}
      </RegionBody>
    </>
  );
}

/** R2: what the scan did, step by step, with the final screen and its own test battle. */
function Timeline() {
  const vm = useView(selectRecognitionPage);
  const s = vm.status;
  const tl = t.timeline;
  if (s.read !== 'ready') return null;
  return (
    <div className="tp-recognition__timeline" data-timeline="true">
      <h3>{tl.title.short}</h3>
      {s.activity === null ? null : (
        <p className="tp-recognition__line">
          <span>{tl.activity.short}</span>
          {s.activity.phase === null ? null : <ServerValue kind="id" value={s.activity.phase} />}
          {at(s.activity.at, tl.activityAt)}
        </p>
      )}
      {s.phases.length === 0 ? (
        <p>{tl.noPhases.short}</p>
      ) : (
        <ul className="tp-recognition__list" aria-label={tl.phases.short}>
          {s.phases.map((phase) => (
            <li key={phase.name} data-phase={phase.name}>
              <ServerValue kind="id" value={phase.name} />
              {phase.status === null ? null : (
                <ServerValue kind="id" label={tl.phaseStatus.short} value={phase.status} />
              )}
              {phase.error === null ? null : <ServerValue kind="message" value={phase.error} />}
            </li>
          ))}
        </ul>
      )}
      {s.finalScreen === null ? (
        <p>{tl.noFinalScreen.short}</p>
      ) : (
        <div
          className="tp-recognition__line"
          data-final-screen={s.finalScreen.verified ? 'verified' : 'not-verified'}
        >
          <span>{tl.finalScreen.short}</span>
          {s.finalScreen.name === null ? null : (
            <ServerValue kind="id" value={s.finalScreen.name} />
          )}
          <Line entry={s.finalScreen.verified ? tl.finalVerified : tl.finalNotVerified} />
          {at(s.finalScreen.at, tl.observedAt)}
          {s.finalScreen.error === null ? null : (
            <ServerValue kind="message" value={s.finalScreen.error} />
          )}
        </div>
      )}
      {s.setupBattle === null ? (
        <p>{tl.noSetupBattle.short}</p>
      ) : (
        <div className="tp-recognition__line" data-setup-battle="true">
          <span>{tl.setupBattle.short}</span>
          {s.setupBattle.status === null ? null : (
            <ServerValue kind="id" value={s.setupBattle.status} />
          )}
          {at(s.setupBattle.startedAt, tl.battleStarted)}
          {at(s.setupBattle.finishedAt, tl.battleFinished)}
          {s.setupBattle.reason === null ? null : (
            <ServerValue kind="message" value={s.setupBattle.reason} />
          )}
        </div>
      )}
    </div>
  );
}

function EntryItem({ entry }: { readonly entry: EvidenceEntryVM }) {
  const e = t.evidence;
  return (
    <li className="tp-recognition__entry" data-entry-status={entry.status}>
      <ServerValue kind="id" value={entry.rel} />
      <span className="tp-recognition__entry-status tp-recognition__pair">
        <span>{e.statuses[entry.status].short}</span>
        {entry.status === 'other' && entry.statusText !== null ? (
          <ServerValue kind="id" value={entry.statusText} />
        ) : null}
      </span>
      {entry.screen === null ? null : (
        <ServerValue kind="id" label={e.columns.screen.short} value={entry.screen} />
      )}
      <span className="tp-recognition__pair">
        <span>{e.columns.scores.short}</span>
        <span>{e.score(entry.self, entry.next)}</span>
      </span>
      {entry.reason === null ? null : <ServerValue kind="message" value={entry.reason} />}
    </li>
  );
}

/** R3 and roadmap item 9: what the report wrote, image by image, never more. */
function EvidenceSection() {
  const vm = useView(selectRecognitionPage);
  const s = vm.status;
  const e = t.evidence;
  const r = t.roadmap;
  return (
    <RegionBody>
      <Line entry={e.intro} />
      {s.evidenceUnavailable ? (
        <div data-evidence-unavailable="true">
          <Line entry={e.unavailable} />
        </div>
      ) : null}
      {s.stale ? (
        <div data-stale="true">
          <Line entry={t.status.stale} />
        </div>
      ) : null}
      <div className="tp-recognition__roadmap" data-roadmap="true">
        <h3>{r.title.short}</h3>
        <Line entry={r.intro} />
        {s.evidenceUnavailable ? null : (
          <ul className="tp-recognition__groups">
            {s.groups.map((group) => (
              <li key={group.group} data-group={group.group} data-count={group.entries.length}>
                <span className="tp-recognition__group-name">{r.groups[group.group].short}</span>
                {group.entries.length === 0 ? (
                  <span>{r.notInReport.short}</span>
                ) : (
                  <ul className="tp-recognition__entries">
                    {group.entries.map((entry) => (
                      <EntryItem key={entry.rel} entry={entry} />
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        <div data-not-reported="gaps">
          <Line entry={r.gaps} />
        </div>
        <div data-not-reported="metrics">
          <Line entry={r.metrics} />
        </div>
      </div>
      {s.artifactErrors.length === 0 ? null : (
        <div data-artifact-errors="true">
          <Line entry={e.artifactErrors} />
          <ul className="tp-recognition__list">
            {s.artifactErrors.map((error) => (
              <li key={error.name}>
                <ServerValue kind="id" value={error.name} />
                <ServerValue kind="message" value={error.message} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.evidenceUnavailable ? null : (
        <Disclosure
          label={e.title.short}
          count={s.entries.length}
          focusKey="recognition:evidence:entries"
        >
          {s.entries.length === 0 ? (
            <p>{e.none.short}</p>
          ) : (
            <ul className="tp-recognition__entries" data-report-entries="true">
              {s.entries.map((entry) => (
                <EntryItem key={entry.rel} entry={entry} />
              ))}
            </ul>
          )}
        </Disclosure>
      )}
      {s.modules.length === 0 && s.cards.length === 0 && s.player.length === 0 ? null : (
        <Disclosure
          label={e.player.short}
          count={s.modules.length + s.cards.length + s.player.length}
          focusKey="recognition:evidence:player"
        >
          {s.modules.length === 0 ? null : (
            <ul className="tp-recognition__list" aria-label={e.modules.short}>
              {s.modules.map((module) => (
                <li key={module.slug}>
                  <ServerValue kind="id" value={module.slug} />
                  {module.rarity === null ? null : <ServerValue kind="id" value={module.rarity} />}
                  <span>{module.slot === null ? e.noSlot.short : e.slot(module.slot)}</span>
                </li>
              ))}
            </ul>
          )}
          {s.cards.length === 0 ? null : (
            <ul className="tp-recognition__list" aria-label={e.cards.short}>
              {s.cards.map((card) => (
                <li key={card.name}>
                  <ServerValue kind="id" value={card.name} />
                  <span>{card.slot === null ? e.noSlot.short : e.slot(card.slot)}</span>
                </li>
              ))}
            </ul>
          )}
          {s.player.length === 0 ? null : (
            <ul className="tp-recognition__list" aria-label={e.player.short}>
              {s.player.map((item) => (
                <li key={item.key}>
                  <ServerValue kind="id" value={item.key} />
                  {item.value === null ? null : <ServerValue kind="message" value={item.value} />}
                </li>
              ))}
            </ul>
          )}
        </Disclosure>
      )}
    </RegionBody>
  );
}

function Card({ card }: { readonly card: ReadinessCardVM }) {
  const r = t.run;
  return (
    <li className="tp-recognition__card" data-blocking={String(card.blocking)}>
      <div className="tp-recognition__card-head">
        <span>{(card.blocking ? r.blocking : r.optional).short}</span>
        {card.setting ? <span>{r.setting.short}</span> : null}
      </div>
      {card.docs.map((doc, index) => (
        <div key={String(index)} className="tp-recognition__doc">
          {doc.label === null ? null : <ServerValue kind="name" value={doc.label} />}
          {doc.what === null ? null : (
            <ServerValue kind="message" label={r.what.short} value={doc.what} />
          )}
          {doc.where === null ? null : (
            <ServerValue kind="message" label={r.where.short} value={doc.where} />
          )}
          {doc.how === null ? null : (
            <ServerValue kind="message" label={r.how.short} value={doc.how} />
          )}
          {doc.step === null ? null : (
            <ServerValue kind="message" label={r.step.short} value={doc.step} />
          )}
        </div>
      ))}
      {card.alternatives.length === 0 ? null : (
        <div>
          <span>{r.anyOf.short}</span>
          <ul className="tp-recognition__list">
            {card.alternatives.map((alternative) => (
              <li key={alternative}>
                <ServerValue kind="id" value={alternative} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {card.reasons.length === 0 ? null : (
        <div>
          <span>{r.why.short}</span>
          {card.reasons.map((reason, index) => (
            <ServerValue key={String(index)} kind="message" value={reason} />
          ))}
        </div>
      )}
    </li>
  );
}

/** R4: choose a run, check what it needs, and prepare it with its own consent. */
function RunSection() {
  const vm = useView(selectRecognitionPage);
  const { commands } = useDashboard();
  const [asking, setAsking] = useState(false);
  const pickId = useId();
  const r = t.run;
  const run = vm.run;
  const readiness = run.readiness;
  if (asking && !run.prepare.enabled) setAsking(false);
  return (
    <RegionBody>
      <Line entry={r.intro} />
      {run.read === 'not_read' ? <p>{r.notRead.short}</p> : null}
      {run.read === 'unavailable' ? <p>{r.unavailable.short}</p> : null}
      <div className="tp-recognition__row">
        <label htmlFor={pickId}>{r.pick.short}</label>
        <select
          id={pickId}
          value={run.selected ?? ''}
          data-focus-key="recognition:run"
          onChange={(event) => {
            const value = event.currentTarget.value;
            commands.selectRecognitionRun(value === '' ? null : value);
          }}
        >
          <option value="">{r.none.short}</option>
          {run.runs.map((entry) => (
            <ServerOption key={entry.name} value={entry.name} label={entry.label} />
          ))}
        </select>
        <Action
          vm={run.check}
          label={run.checking ? r.checking : r.check}
          focusKey="recognition:run:check"
          onClick={() => {
            void commands.checkRecognitionReadiness();
          }}
        />
      </div>
      {readiness === null ? null : (
        <div
          className="tp-recognition__readiness"
          data-readiness={readiness.state === 'failed' ? 'failed' : readiness.line}
        >
          <p>
            <span>{r.checkedAgo(readiness.ageSec)}</span>
            {readiness.httpStatus === null || readiness.httpStatus === 200 ? null : (
              <span>{r.httpStatus(readiness.httpStatus)}</span>
            )}
          </p>
          {readiness.state === 'failed' ? (
            <Line entry={r.failed} />
          ) : (
            <>
              {readiness.forThisPage === false ? (
                <div data-other-context="true">
                  <Line entry={r.otherContext} />
                </div>
              ) : null}
              <Line entry={r.lines[readiness.line]} />
              {readiness.message === null ? null : (
                <ServerValue kind="message" value={readiness.message} />
              )}
              {readiness.error === null ? null : (
                <ServerValue kind="message" value={readiness.error} />
              )}
              {readiness.actionLabel === null ? null : (
                <ServerValue kind="message" label={r.next.short} value={readiness.actionLabel} />
              )}
              {readiness.missing.length === 0 ? null : (
                <div>
                  <h3>{r.missing.short}</h3>
                  <ul className="tp-recognition__cards" data-cards="missing">
                    {readiness.missing.map((card, index) => (
                      <Card key={String(index)} card={card} />
                    ))}
                  </ul>
                </div>
              )}
              {readiness.advisory.length === 0 ? null : (
                <div>
                  <h3>{r.advisory.short}</h3>
                  <ul className="tp-recognition__cards" data-cards="advisory">
                    {readiness.advisory.map((card, index) => (
                      <Card key={String(index)} card={card} />
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
      <div className="tp-recognition__row">
        <Action
          vm={run.prepare}
          label={r.prepare}
          focusKey="recognition:run:prepare"
          onClick={() => {
            setAsking(true);
          }}
        />
      </div>
      <ConfirmDialog
        open={asking}
        tier="primary"
        title={r.prepareConfirm.short}
        body={<p>{r.prepareEffects.short}</p>}
        confirmLabel={r.prepareSend.short}
        cancelLabel={r.cancel.short}
        onCancel={() => {
          setAsking(false);
        }}
        onConfirm={() => {
          setAsking(false);
          const command = run.prepare.command;
          if (run.prepare.enabled && command !== null) void commands.recognitionLaunch(command);
        }}
      />
    </RegionBody>
  );
}

/** R5: capture now or watch for a while; never taps or navigates. */
function ObserveSection() {
  const vm = useView(selectRecognitionPage);
  const { commands } = useDashboard();
  const watchId = useId();
  const o = t.observe;
  const observe = vm.observe;
  const invalid = observe.watch.kind === 'invalid';
  return (
    <RegionBody>
      <Line entry={o.intro} />
      <div className="tp-recognition__row">
        <Action
          vm={observe.capture}
          label={o.capture}
          focusKey="recognition:observe:capture"
          onClick={(command) => {
            void commands.recognitionLaunch(command);
          }}
        />
      </div>
      <div className="tp-recognition__row">
        <label htmlFor={watchId}>{o.watchLabel.short}</label>
        <input
          id={watchId}
          type="text"
          inputMode="numeric"
          className="tp-recognition__number"
          value={observe.watchText}
          aria-invalid={invalid}
          data-focus-key="recognition:observe:seconds"
          disabled={observe.scope === null}
          onChange={(event) => {
            if (observe.scope !== null)
              commands.editDraft(observe.scope, 'seconds', event.currentTarget.value);
          }}
        />
        <Action
          vm={observe.watchStart}
          label={o.watch}
          focusKey="recognition:observe:watch"
          onClick={(command) => {
            void commands.recognitionLaunch(command);
          }}
        />
      </div>
    </RegionBody>
  );
}

/** R6, R8: the basic scan with remembered choices, and the equipped-modules scan. */
function MoreScansSection() {
  const vm = useView(selectRecognitionPage);
  const { commands } = useDashboard();
  const [asking, setAsking] = useState<'basic' | 'equipped' | null>(null);
  const [equippedOverwrite, setEquippedOverwrite] = useState(false);
  const b = t.basic;
  const q = t.equipped;
  const basic = vm.basic;
  const scope = basic.scope;
  const offered =
    asking === 'basic' ? basic.start.enabled : asking === 'equipped' ? vm.equipped.enabled : true;
  if (asking !== null && !offered) setAsking(null);
  const flag = (path: string, checked: boolean) => {
    if (scope !== null) commands.editDraft(scope, path, checked);
  };
  return (
    <RegionBody>
      <Disclosure label={b.title.short} focusKey="recognition:basic">
        <Line entry={b.intro} />
        <fieldset className="tp-recognition__choices" disabled={scope === null}>
          <legend>{b.legend.short}</legend>
          {basic.features.map((feature) => (
            <label key={feature.feature} className="tp-recognition__check">
              <input
                type="checkbox"
                checked={feature.on}
                data-feature={feature.feature}
                data-focus-key={`recognition:basic:${feature.feature}`}
                onChange={(event) => {
                  flag(`feature:${feature.feature}`, event.currentTarget.checked);
                }}
              />
              <span>{b.features[feature.feature].short}</span>
            </label>
          ))}
          <label className="tp-recognition__check">
            <input
              type="checkbox"
              checked={basic.choices.fresh}
              data-focus-key="recognition:basic:fresh"
              onChange={(event) => {
                flag('fresh', event.currentTarget.checked);
              }}
            />
            <span>{b.fresh.short}</span>
          </label>
          <label className="tp-recognition__check">
            <input
              type="checkbox"
              checked={basic.choices.navigation}
              data-focus-key="recognition:basic:navigation"
              onChange={(event) => {
                flag('navigation', event.currentTarget.checked);
              }}
            />
            <span>{b.navigation.short}</span>
          </label>
          <label className="tp-recognition__check">
            <input
              type="checkbox"
              checked={basic.choices.overwrite}
              data-focus-key="recognition:basic:overwrite"
              onChange={(event) => {
                flag('overwrite', event.currentTarget.checked);
              }}
            />
            <span>{b.overwrite.short}</span>
          </label>
        </fieldset>
        <div className="tp-recognition__row">
          <Action
            vm={basic.start}
            label={b.start}
            focusKey="recognition:basic:start"
            onClick={() => {
              setAsking('basic');
            }}
          />
        </div>
      </Disclosure>
      <Disclosure label={q.title.short} focusKey="recognition:equipped">
        <Line entry={q.intro} />
        <label className="tp-recognition__check">
          <input
            type="checkbox"
            checked={equippedOverwrite}
            data-focus-key="recognition:equipped:overwrite"
            onChange={(event) => {
              setEquippedOverwrite(event.currentTarget.checked);
            }}
          />
          <span>{q.overwrite.short}</span>
        </label>
        <div className="tp-recognition__row">
          <Action
            vm={vm.equipped}
            label={q.start}
            focusKey="recognition:equipped:start"
            onClick={() => {
              setAsking('equipped');
            }}
          />
        </div>
      </Disclosure>
      <ConfirmDialog
        open={asking === 'basic'}
        tier="primary"
        title={b.confirm.short}
        body={
          <ul className="tp-recognition__effects" data-effects="basic">
            {basic.features
              .filter((feature) => feature.on)
              .map((feature) => (
                <li key={feature.feature}>{b.features[feature.feature].short}</li>
              ))}
            <li>{(basic.choices.navigation ? b.navigation : b.noNavigation).short}</li>
            <li>
              {(basic.choices.overwrite ? t.learn.effects.overwrite : t.learn.effects.keep).short}
            </li>
          </ul>
        }
        confirmLabel={b.send.short}
        cancelLabel={b.cancel.short}
        onCancel={() => {
          setAsking(null);
        }}
        onConfirm={() => {
          setAsking(null);
          const command = basic.start.command;
          if (basic.start.enabled && command !== null) void commands.recognitionLaunch(command);
        }}
      />
      <ConfirmDialog
        open={asking === 'equipped'}
        tier="primary"
        title={q.confirm.short}
        body={
          <ul className="tp-recognition__effects" data-effects="equipped">
            <li>{q.effects.short}</li>
            <li>{(equippedOverwrite ? t.learn.effects.overwrite : t.learn.effects.keep).short}</li>
          </ul>
        }
        confirmLabel={q.send.short}
        cancelLabel={q.cancel.short}
        onCancel={() => {
          setAsking(null);
        }}
        onConfirm={() => {
          setAsking(null);
          const base = vm.equipped.command;
          if (!vm.equipped.enabled || base === null) return;
          void commands.recognitionLaunch({
            ...base,
            launch: { kind: 'start', plan: { kind: 'equipped', overwrite: equippedOverwrite } },
          });
        }}
      />
    </RegionBody>
  );
}

/**
 * The Recognition page (screens brief R1 to R8; R9 to R11 in Advanced repairs). Opening it
 * reads the calibrator status, the followed operation, runs, battles and the device's
 * processes; every scan, apply and stop is a person's click with its own consent.
 */
export function RecognitionPage({
  Advanced,
}: {
  readonly Advanced: ComponentType<{ readonly run: string | null }>;
}) {
  const { commands } = useDashboard();
  const vm = useView(selectRecognitionPage);
  useEffect(() => {
    commands.openRecognition(true);
    return () => {
      commands.openRecognition(false);
    };
  }, [commands]);
  return (
    <>
      <header className="tp-topbar">
        <RegionBoundary
          fallback={<RevocationFallback part="topBar" />}
          resetKey={useEpochKey()}
          onError={usePartError('topBar')}
        >
          <FaultPoint part="topBar" />
          <TopBar title={t.pageName.short} />
        </RegionBoundary>
      </header>
      <main id="main" className="tp-main" tabIndex={-1}>
        <FaultPoint part="page" />
        <div className="tp-recognition">
          <div className="tp-recognition__notice">
            <NotSent />
          </div>
          <div className="tp-recognition__journey">
            <RecognitionRegion id="recognitionTarget" title={t.target.title}>
              <TargetSection />
            </RecognitionRegion>
            <RecognitionRegion id="recognitionLearn" title={t.learn.title}>
              <LearnSection />
            </RecognitionRegion>
            <RecognitionRegion id="recognitionRun" title={t.run.title}>
              <RunSection />
            </RecognitionRegion>
            <RecognitionRegion id="recognitionObserve" title={t.observe.title}>
              <ObserveSection />
            </RecognitionRegion>
          </div>
          <div className="tp-recognition__state">
            <RecognitionRegion id="recognitionOperation" title={t.operation.title}>
              <OperationSection />
            </RecognitionRegion>
            <RecognitionRegion id="recognitionEvidence" title={t.evidence.title}>
              <EvidenceSection />
            </RecognitionRegion>
          </div>
          <div className="tp-recognition__more">
            <RecognitionRegion id="recognitionMore" title={t.more.title}>
              <MoreScansSection />
            </RecognitionRegion>
            <RecognitionRegion id="recognitionAdvanced" title={t.advanced.title}>
              <RegionBody>
                <Advanced run={vm.run.selected} />
              </RegionBody>
            </RecognitionRegion>
          </div>
        </div>
      </main>
    </>
  );
}
