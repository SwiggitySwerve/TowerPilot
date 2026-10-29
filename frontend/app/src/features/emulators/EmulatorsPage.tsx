import { useCallback, useEffect, useId, useState } from 'react';
import { copy } from '../../copy/catalogue.ts';
import { emulators as t } from '../../copy/emulators.ts';
import type { CopyEntry, CopyNode } from '../../copy/text.ts';
import {
  selectEmulatorsPage,
  type EmulatorOutcomeVM,
  type EmulatorRowVM,
  type EmulatorWriteCommand,
  type EmulatorsPageVM,
  type ResolutionVM,
} from '../../store/selectors/emulators.ts';
import { selectOutcomes } from '../../store/selectors/outcomes.ts';
import type { CommandVM } from '../../store/viewModels.ts';
import { Button } from '../../ui/Button.tsx';
import { Chip } from '../../ui/Chip.tsx';
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx';
import { Notice } from '../../ui/Notice.tsx';
import { RegionBoundary } from '../../ui/RegionBoundary.tsx';
import { Region, RegionBody, RegionEnd } from '../../ui/Region.tsx';
import { pageHref } from '../../ui/routes.ts';
import { ServerValue } from '../../ui/ServerValue.tsx';
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
import { SettingsModuleForm } from '../settings/SettingsModuleForm.tsx';
import './emulators.css';
import { EmulatorSettings } from './EmulatorSettings.tsx';

const connectionLines: Readonly<Record<string, CopyEntry>> = copy.dashboard.topBar.connection;
/** The requests this page owns; their owner notices are shown here (the shared notice). */
const PAGE_KINDS: readonly string[] = ['adopt', 'launch', 'prepare', 'tools_install', 'reconnect'];

/** The column name inside a cell: hidden while the table is a table, shown on the 390 cards. */
function CellLabel({ entry }: { readonly entry: CopyEntry }) {
  return <span className="tp-emulators__cell-label">{entry.short}</span>;
}

function reasonOf(reason: string | null): CopyEntry {
  const reasons: Readonly<Record<string, CopyEntry>> = t.reasons;
  return (reason === null ? undefined : reasons[reason]) ?? t.reasons.context_unknown;
}

function Line({ entry }: { readonly entry: CopyEntry }) {
  return (
    <div className="tp-emulators__line">
      <span>{entry.short}</span>
      {entry.why === undefined ? null : <Why why={entry.why} />}
    </div>
  );
}

/** One action button, the same element whatever its state; disabled with its visible reason. */
function Action({
  vm,
  label,
  focusKey,
  onClick,
  tier = 'secondary',
}: {
  readonly vm: CommandVM<unknown>;
  readonly label: CopyEntry;
  readonly focusKey: string;
  readonly onClick: () => void;
  readonly tier?: 'secondary' | 'quiet';
}) {
  const own = useId();
  return (
    <span className="tp-emulators__action">
      <Button
        tier={tier}
        label={label.short}
        focusKey={focusKey}
        busy={vm.sending}
        {...(vm.enabled ? {} : { disabled: true as const, reasonId: `${own}-reason` })}
        onClick={() => {
          if (vm.enabled) onClick();
        }}
      />
      {vm.enabled ? null : (
        <span id={`${own}-reason`} className="tp-reason">
          {reasonOf(vm.reason).short}
        </span>
      )}
    </span>
  );
}

function outcomeLine(outcome: EmulatorOutcomeVM): CopyEntry {
  const o = t.outcomes;
  switch (outcome.code) {
    case 'sending':
      return o.sending;
    case 'refused':
      return o.refused;
    case 'unknown':
      return o.unknown;
    case 'applied':
      return o.applied;
    case 'not_applied':
      return o.not_applied;
    case 'saved':
      return o.adopt.saved;
    case 'accepted':
      return outcome.kind === 'tools_install' ? o.install.accepted : o.launch.accepted;
    case 'already_running':
      return o.install.already_running;
    case 'failed':
      return outcome.kind === 'reconnect' ? o.reconnect.failed : o.launch.failed;
    case 'done':
      if (outcome.kind === 'reconnect') return o.reconnect.done;
      return outcome.changed.length === 0 && outcome.added.length === 0
        ? o.prepare.nothing
        : o.prepare.done;
  }
}

/** The newest request of one action: what it proved, the server's words, and Dismiss. */
function Outcome({ outcome }: { readonly outcome: EmulatorOutcomeVM }) {
  const { commands } = useDashboard();
  const entry = outcomeLine(outcome);
  const connect =
    outcome.kind === 'adopt' && outcome.code === 'saved'
      ? outcome.connected === true
        ? t.outcomes.adopt.connected
        : outcome.connected === false
          ? t.outcomes.adopt.notConnected
          : t.outcomes.adopt.connectUnknown
      : null;
  const details =
    outcome.message !== null ||
    outcome.error !== null ||
    outcome.backup !== null ||
    outcome.changed.length > 0 ||
    outcome.added.length > 0 ||
    connect !== null;
  return (
    <div
      className="tp-emulators__outcome"
      data-outcome={outcome.code}
      data-kind={outcome.kind}
      data-intent={outcome.id}
    >
      <Notice
        state={outcome.word}
        lead={
          <>
            <span>{t.outcomes.lead.short}</span>
            {outcome.answeredAgeSec === null ? null : (
              <span>{t.outcomes.answeredAgo(outcome.answeredAgeSec)}</span>
            )}
            {outcome.restored ? <span>{t.outcomes.restored.short}</span> : null}
          </>
        }
        line={
          <span className="tp-emulators__outcome-line">
            <span>{entry.short}</span>
            {outcome.target === null ? null : <ServerValue kind="id" value={outcome.target} />}
            {outcome.deviceState === null ? null : (
              <ServerValue kind="id" value={outcome.deviceState} />
            )}
          </span>
        }
        {...(entry.why === undefined ? {} : { why: entry.why })}
        {...(details
          ? {
              server: (
                <>
                  {connect === null ? null : (
                    <span data-connect={String(outcome.connected)}>{connect.short}</span>
                  )}
                  {outcome.message === null ? null : (
                    <ServerValue kind="message" value={outcome.message} />
                  )}
                  {outcome.error === null ? null : outcome.code === 'unknown' ? (
                    <span data-server-error="true">
                      <span>{t.outcomes.serverError.short}</span>
                      <ServerValue kind="message" value={outcome.error} />
                    </span>
                  ) : (
                    <span data-refusal="true">
                      <ServerValue kind="message" value={outcome.error} />
                    </span>
                  )}
                  {outcome.changed.length === 0 ? null : (
                    <ul className="tp-emulators__changes">
                      {outcome.changed.map((change, index) => (
                        <li key={String(index)}>
                          {change.key === null ? null : (
                            <ServerValue kind="id" value={change.key} />
                          )}
                          {change.from === null ? null : (
                            <ServerValue kind="id" value={change.from} />
                          )}
                          {change.to === null ? null : <ServerValue kind="id" value={change.to} />}
                        </li>
                      ))}
                    </ul>
                  )}
                  {outcome.added.length === 0 ? null : (
                    <span>
                      <span>{t.outcomes.prepare.added.short}</span>
                      {outcome.added.map((key) => (
                        <ServerValue key={key} kind="id" value={key} />
                      ))}
                    </span>
                  )}
                  {outcome.backup === null ? null : (
                    <span>
                      <span>{t.outcomes.prepare.backup.short}</span>
                      <ServerValue kind="id" value={outcome.backup} />
                    </span>
                  )}
                </>
              ),
            }
          : {})}
        actions={
          outcome.dismissOffered ? (
            <Button
              tier="quiet"
              label={t.outcomes.dismiss.short}
              focusKey={`emulator-outcome:${outcome.id}:dismiss`}
              onClick={() => {
                commands.dismiss(outcome.id);
              }}
            />
          ) : null
        }
      />
    </div>
  );
}

function EmulatorsRegion({
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
      fallback={<RevocationFallback part="emulators" />}
      resetKey={useEpochKey()}
      onError={usePartError(id)}
    >
      <FaultPoint part={id} />
      {children}
    </Region>
  );
}

/** M8: the owner notice of a refused request of this page (the shared, D-4-judged notice). */
function PageOwnerNotice() {
  const vm = useView(selectOutcomes);
  const { commands } = useDashboard();
  const notice = vm.ownerNotice;
  if (notice === null || !PAGE_KINDS.includes(notice.action)) return null;
  return (
    <div className="tp-emulators__owner" data-owner-notice="true">
      <OwnerNotice
        notice={notice}
        onDismiss={() => {
          commands.dismiss(notice.intentId);
        }}
      />
    </div>
  );
}

function Resolution({ vm }: { readonly vm: ResolutionVM }) {
  const r = t.resolution;
  return (
    <div className="tp-emulators__resolution" data-resolution={vm.kind}>
      <ul className="tp-emulators__facts">
        {vm.kind === 'no_result' ? (
          <>
            <li>{(vm.answered ? r.unreadable : r.noAnswer).short}</li>
            {vm.status === null ? null : <li>{r.status(vm.status)}</li>}
          </>
        ) : vm.kind === 'measured' ? (
          <>
            <li data-size="true">{r.size(vm.width, vm.height)}</li>
            <li>{(vm.portrait ? r.portrait : r.landscape).short}</li>
            {vm.portrait ? <li>{(vm.reference ? r.reference : r.notReference).short}</li> : null}
            {vm.note === null ? null : (
              <li>
                <ServerValue kind="message" value={vm.note} />
              </li>
            )}
          </>
        ) : (
          <>
            <li>{r.failed.short}</li>
            {vm.error === null ? null : (
              <li>
                <ServerValue kind="message" value={vm.error} />
              </li>
            )}
          </>
        )}
        {vm.checkedAgeSec === null ? null : <li>{r.checkedAgo(vm.checkedAgeSec)}</li>}
        {vm.kind === 'no_result' || vm.savedAt === null ? null : <li>{r.savedAt(vm.savedAt)}</li>}
      </ul>
    </div>
  );
}

/** M6, M8: the active instance, its address, the live connection, reconnect and screen size. */
function TargetSection() {
  const vm = useView(selectEmulatorsPage);
  const { commands } = useDashboard();
  const [checking, setChecking] = useState(false);
  const line = connectionLines[vm.connection.line];
  const serial = vm.resolution.serial;
  return (
    <>
      <RegionEnd>
        {vm.connectionAgeSec === null ? null : <span>{t.target.liveAge(vm.connectionAgeSec)}</span>}
      </RegionEnd>
      <RegionBody>
        <Line entry={t.target.scope} />
        <PageOwnerNotice />
        <dl className="tp-emulators__facts-list">
          <div>
            <dt>{t.target.instance.short}</dt>
            <dd>{vm.instance === null ? null : <ServerValue kind="id" value={vm.instance} />}</dd>
          </div>
          <div>
            <dt>{t.target.account.short}</dt>
            <dd>
              {vm.account === null ? (
                t.target.noAccount.short
              ) : (
                <ServerValue kind="id" value={vm.account} />
              )}
            </dd>
          </div>
          <div>
            <dt>{t.target.address.short}</dt>
            <dd data-configured-serial="true">
              {vm.configuredSerial === null ? (
                t.target.notSet.short
              ) : (
                <>
                  <ServerValue kind="id" value={vm.configuredSerial} />
                  {vm.configuredName === null ? null : (
                    <ServerValue kind="name" value={vm.configuredName} />
                  )}
                  <span className="tp-emulators__muted">
                    {
                      (vm.portOpen === true
                        ? t.target.port.open
                        : vm.portOpen === false
                          ? t.target.port.closed
                          : t.target.port.unknown
                      ).short
                    }
                  </span>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>{t.target.live.short}</dt>
            <dd data-live={vm.connection.line}>
              {vm.connection.word === null ? null : <Chip state={vm.connection.word} />}
              <span>{line?.short}</span>
              <Why why={t.target.liveNote.why ?? t.target.liveNote.short} />
            </dd>
          </div>
        </dl>
        {vm.unconfigured ? (
          <div data-unconfigured="true">
            <Line entry={t.target.unconfigured} />
          </div>
        ) : null}
        {vm.boot === null ? null : (
          <div className="tp-emulators__line" data-boot="true">
            <span>{t.target.boot.short}</span>
            {vm.boot.ageSec === null ? null : <span>{t.target.liveAge(vm.boot.ageSec)}</span>}
            {t.target.boot.why === undefined ? null : <Why why={t.target.boot.why} />}
          </div>
        )}
        <div className="tp-emulators__row">
          <Action
            vm={vm.reconnect}
            label={t.target.reconnect}
            focusKey="emulators:reconnect"
            onClick={() => {
              if (vm.reconnect.command !== null) void commands.reconnect(vm.reconnect.command);
            }}
          />
          <a href={pageHref('dashboard')}>{t.target.dashboard.short}</a>
        </div>
        {vm.reconnectOutcome === null ? null : <Outcome outcome={vm.reconnectOutcome} />}
        {vm.adoptOutcome === null ? null : <Outcome outcome={vm.adoptOutcome} />}
        <section className="tp-emulators__sub" aria-labelledby="emulators-resolution-title">
          <h3 id="emulators-resolution-title">{t.resolution.title.short}</h3>
          <div className="tp-emulators__row">
            <Action
              vm={{
                shown: true,
                enabled: serial !== null && !checking,
                reason: serial === null ? 'no_address' : checking ? 'sending' : null,
                sending: checking,
                command: null,
              }}
              label={t.resolution.check}
              focusKey="emulators:resolution"
              onClick={() => {
                if (serial === null) return;
                setChecking(true);
                void commands.checkResolution(serial).finally(() => {
                  setChecking(false);
                });
              }}
            />
          </div>
          {checking ? <p>{t.resolution.checking.short}</p> : null}
          {vm.resolution.check === null ? null : <Resolution vm={vm.resolution.check} />}
          {(vm.resolution.check === null || vm.resolution.check.kind === 'no_result') &&
          vm.resolution.saved !== null ? (
            <Resolution vm={vm.resolution.saved} />
          ) : null}
          <Line entry={t.resolution.note} />
        </section>
      </RegionBody>
    </>
  );
}

function Row({
  row,
  onUse,
  onLaunch,
  onPrepare,
}: {
  readonly row: EmulatorRowVM;
  readonly onUse: (command: EmulatorWriteCommand, row: EmulatorRowVM) => void;
  readonly onLaunch: (command: EmulatorWriteCommand) => void;
  readonly onPrepare: (command: EmulatorWriteCommand) => void;
}) {
  const d = t.detected;
  return (
    <tr data-row={row.key}>
      <td>
        <CellLabel entry={d.columns.emulator} />
        {row.emulator === null ? null : <ServerValue kind="name" value={row.emulator} />}
      </td>
      <td>
        <CellLabel entry={d.columns.instance} />
        {row.name === null ? null : <ServerValue kind="name" value={row.name} />}
      </td>
      <td>
        <CellLabel entry={d.columns.state} />
        <span className="tp-emulators__cell">
          <span>
            {
              (row.running === true
                ? d.running
                : row.running === false
                  ? d.off
                  : row.listed
                    ? d.stateUnknown
                    : d.stateNotReported
              ).short
            }
          </span>
          {row.displayNotReady ? (
            <span className="tp-emulators__warn">
              <span>{d.display.short}</span>
              {row.display === null ? null : <ServerValue kind="id" value={row.display} />}
            </span>
          ) : null}
          {row.error === null ? null : <ServerValue kind="message" value={row.error} />}
        </span>
      </td>
      <td>
        <CellLabel entry={d.columns.address} />
        {row.serial === null ? null : <ServerValue kind="id" value={row.serial} />}
      </td>
      <td>
        <CellLabel entry={d.columns.actions} />
        <span className="tp-emulators__cell">
          {row.inUse ? <span data-in-use="true">{d.inUse.short}</span> : null}
          {row.use === null ? null : (
            <Action
              vm={row.use}
              label={d.use}
              focusKey={`emulators:use:${row.key}`}
              onClick={() => {
                if (row.use?.command != null) onUse(row.use.command, row);
              }}
            />
          )}
          {row.openGame === null ? null : (
            <Action
              vm={row.openGame}
              label={d.openGame}
              focusKey={`emulators:open:${row.key}`}
              onClick={() => {
                if (row.openGame?.command != null) onLaunch(row.openGame.command);
              }}
            />
          )}
          {row.start === null ? null : (
            <Action
              vm={row.start}
              label={d.start}
              focusKey={`emulators:start:${row.key}`}
              onClick={() => {
                if (row.start?.command != null) onLaunch(row.start.command);
              }}
            />
          )}
          {row.prepare === null ? null : (
            <Action
              vm={row.prepare}
              tier="quiet"
              label={d.prepare}
              focusKey={`emulators:prepare:${row.key}`}
              onClick={() => {
                if (row.prepare?.command != null) onPrepare(row.prepare.command);
              }}
            />
          )}
          {row.launchOutcome === null ? null : <Outcome outcome={row.launchOutcome} />}
          {row.prepareOutcome === null ? null : <Outcome outcome={row.prepareOutcome} />}
        </span>
      </td>
    </tr>
  );
}

/** M1 to M4: the last scan, the suggestion, each detected emulator and its explicit actions. */
function DetectedSection() {
  const vm = useView(selectEmulatorsPage);
  const { commands } = useDashboard();
  const d = t.detected;
  const [asking, setAsking] = useState<
    | { readonly kind: 'use'; readonly command: EmulatorWriteCommand; readonly to: string }
    | { readonly kind: 'prepare'; readonly command: EmulatorWriteCommand }
    | null
  >(null);
  const send = useCallback(
    (command: EmulatorWriteCommand) => {
      void commands.emulatorWrite(command);
    },
    [commands],
  );
  const askUse = (command: EmulatorWriteCommand) => {
    if (command.action.kind !== 'adopt') return;
    setAsking({ kind: 'use', command, to: command.action.serial });
  };
  // F6M-C-02: a confirmation opened while the request was allowed closes when it no longer is
  // (a runner listed meanwhile, another request in flight): nothing is sent from it.
  // Adjusting state while rendering (not in an effect) so the stale dialog never paints once.
  if (vm.writeGate !== null && asking !== null) setAsking(null);
  return (
    <>
      <RegionEnd>
        {vm.scan.ageSec === null ? null : <span>{d.scanAge(vm.scan.ageSec)}</span>}
      </RegionEnd>
      <RegionBody>
        <div className="tp-emulators__row">
          <Button
            tier="secondary"
            label={d.rescan.short}
            focusKey="emulators:rescan"
            onClick={() => {
              commands.rescanEmulators();
            }}
          />
        </div>
        {vm.scan.read === 'not_read' ? <p>{d.reading.short}</p> : null}
        {vm.scan.read === 'unavailable' ? <p>{d.unavailable.short}</p> : null}
        {vm.scan.error === null ? null : (
          <p>
            <span>{d.error.short}</span>
            <ServerValue kind="message" value={vm.scan.error} />
          </p>
        )}
        {vm.scan.otherInstance ? <p>{d.otherInstance.short}</p> : null}
        {vm.blueStacksAdb === null ? null : (
          <p data-bluestacks-adb="true">
            {
              (vm.blueStacksAdb.enabled === true
                ? d.blueStacksAdb.on
                : vm.blueStacksAdb.enabled === false
                  ? d.blueStacksAdb.off
                  : d.blueStacksAdb.unknown
              ).short
            }
          </p>
        )}
        {vm.suggestion === null ? null : (
          <div className="tp-emulators__suggestion" data-suggestion="true">
            <span>{d.suggestion.short}</span>
            {vm.suggestion.emulator === null ? null : (
              <ServerValue kind="name" value={vm.suggestion.emulator} />
            )}
            {vm.suggestion.name === null ? null : (
              <ServerValue kind="name" value={vm.suggestion.name} />
            )}
            {vm.suggestion.serial === null ? null : (
              <ServerValue kind="id" value={vm.suggestion.serial} />
            )}
            {vm.suggestion.alsoSeen.length === 0 ? null : (
              <span>
                <span>{d.alsoSeen.short}</span>
                {vm.suggestion.alsoSeen.map((serial) => (
                  <ServerValue key={serial} kind="id" value={serial} />
                ))}
              </span>
            )}
            <Action
              vm={vm.suggestion.use}
              label={d.use}
              focusKey="emulators:use:suggestion"
              onClick={() => {
                const command = vm.suggestion?.use.command;
                if (command != null) askUse(command);
              }}
            />
          </div>
        )}
        {vm.scan.read === 'ready' && vm.rows.length === 0 ? <p>{d.none.short}</p> : null}
        {vm.rows.length === 0 ? null : (
          <table className="tp-emulators__table">
            <thead>
              <tr>
                <th scope="col">{d.columns.emulator.short}</th>
                <th scope="col">{d.columns.instance.short}</th>
                <th scope="col">{d.columns.state.short}</th>
                <th scope="col">{d.columns.address.short}</th>
                <th scope="col">{d.columns.actions.short}</th>
              </tr>
            </thead>
            <tbody>
              {vm.rows.map((row) => (
                <Row
                  key={row.key}
                  row={row}
                  onUse={(command) => {
                    askUse(command);
                  }}
                  onLaunch={send}
                  onPrepare={(command) => {
                    setAsking({ kind: 'prepare', command });
                  }}
                />
              ))}
            </tbody>
          </table>
        )}
        {vm.notProbed.length === 0 ? null : (
          <ul className="tp-emulators__notes">
            {vm.notProbed.map((entry, index) => (
              <li key={String(index)}>
                <span>{d.notProbed.short}</span>
                {entry.emulator === null ? null : (
                  <ServerValue kind="name" value={entry.emulator} />
                )}
                {entry.note === null ? null : <ServerValue kind="message" value={entry.note} />}
              </li>
            ))}
          </ul>
        )}
        {vm.configured.length === 0 ? null : (
          <section className="tp-emulators__sub" aria-labelledby="emulators-configured-title">
            <h3 id="emulators-configured-title">{d.configured.short}</h3>
            <ul className="tp-emulators__notes">
              {vm.configured.map((row, index) => (
                <li key={String(index)} data-configured={row.instance ?? ''}>
                  {row.instance === null ? null : <ServerValue kind="id" value={row.instance} />}
                  {row.serial === null ? (
                    <span>{t.target.notSet.short}</span>
                  ) : (
                    <ServerValue kind="id" value={row.serial} />
                  )}
                  <span className="tp-emulators__muted">
                    {
                      (row.portOpen === true
                        ? d.portOpen
                        : row.portOpen === false
                          ? d.portClosed
                          : d.portUnknown
                      ).short
                    }
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <ConfirmDialog
          open={asking?.kind === 'use'}
          tier="primary"
          title={d.confirmUse.title.short}
          body={
            <p>
              {asking?.kind === 'use' && asking.command.action.kind === 'adopt'
                ? d.confirmUse.body(
                    // F6M-C-01: the instance the request names, the account of that target.
                    asking.command.action.expectInstance,
                    vm.target?.account ?? t.target.noAccount.short,
                    vm.configuredSerial ?? t.target.notSet.short,
                    asking.to,
                  )
                : null}
            </p>
          }
          confirmLabel={d.confirmUse.confirm.short}
          cancelLabel={d.confirmUse.cancel.short}
          onConfirm={() => {
            const command = asking?.command;
            setAsking(null);
            if (command !== undefined && vm.writeGate === null) send(command);
          }}
          onCancel={() => {
            setAsking(null);
          }}
        />
        <ConfirmDialog
          open={asking?.kind === 'prepare'}
          tier="primary"
          title={d.confirmPrepare.title.short}
          body={<p>{d.confirmPrepare.body.short}</p>}
          confirmLabel={d.confirmPrepare.confirm.short}
          cancelLabel={d.confirmPrepare.cancel.short}
          onConfirm={() => {
            const command = asking?.command;
            setAsking(null);
            if (command !== undefined && vm.writeGate === null) send(command);
          }}
          onCancel={() => {
            setAsking(null);
          }}
        />
      </RegionBody>
    </>
  );
}

/** M5: the connection tools, the license consent, the install and its progress reads. */
function ToolsSection() {
  const vm = useView(selectEmulatorsPage);
  const { commands } = useDashboard();
  const [license, setLicense] = useState(false);
  const tools = vm.tools;
  const install: EmulatorsPageVM['tools']['install'] =
    tools.install.enabled && !license
      ? { ...tools.install, enabled: false, reason: 'accept_license', command: null }
      : tools.install;
  return (
    <>
      <RegionEnd>
        {tools.ageSec === null ? null : <span>{t.tools.readAge(tools.ageSec)}</span>}
      </RegionEnd>
      <RegionBody>
        <Line entry={t.tools.intro} />
        <p
          className="tp-emulators__line"
          data-tools={
            tools.read !== 'ready'
              ? tools.read
              : tools.installed
                ? 'installed'
                : (tools.stage ?? 'unknown')
          }
        >
          <span>
            {
              (tools.read === 'not_read'
                ? t.tools.reading
                : tools.read === 'unavailable'
                  ? t.tools.unavailable
                  : tools.installed
                    ? t.tools.installed
                    : t.tools.notInstalled
              ).short
            }
          </span>
          {tools.stage === null ? null : (
            <>
              <span>{t.tools.stage.short}</span>
              <ServerValue kind="id" value={tools.stage} />
            </>
          )}
        </p>
        {tools.message === null ? null : (
          <p role="status">
            <ServerValue kind="message" value={tools.message} />
          </p>
        )}
        {tools.inProgress && tools.percent !== null ? (
          <p className="tp-emulators__line">
            <progress max={100} value={tools.percent} aria-label={t.tools.progress.short} />
            <span>{t.tools.percent(tools.percent)}</span>
          </p>
        ) : null}
        {tools.path === null ? null : (
          <p className="tp-emulators__line">
            <span>{t.tools.path.short}</span>
            <ServerValue kind="id" value={tools.path} />
          </p>
        )}
        {tools.installed ? null : (
          <>
            <label className="tp-emulators__check">
              <input
                type="checkbox"
                checked={license}
                data-focus-key="emulators:license"
                onChange={(event) => {
                  setLicense(event.currentTarget.checked);
                }}
              />
              <span>{t.tools.license.short}</span>
            </label>
            <div className="tp-emulators__row">
              <Action
                vm={install}
                label={t.tools.install}
                focusKey="emulators:install"
                onClick={() => {
                  if (install.command !== null) void commands.emulatorWrite(install.command);
                }}
              />
              <Button
                tier="quiet"
                label={t.tools.check.short}
                focusKey="emulators:tools:check"
                onClick={() => {
                  commands.checkTools();
                }}
              />
            </div>
            {tools.inProgress ? <p>{t.tools.leaving.short}</p> : null}
          </>
        )}
        {tools.outcome === null ? null : <Outcome outcome={tools.outcome} />}
      </RegionBody>
    </>
  );
}

/** M7: the saved preview settings of this emulator (the shared settings editor). */
function PreviewSection() {
  const vm = useView(selectEmulatorsPage);
  const { commands } = useDashboard();
  return (
    <>
      <RegionEnd>
        {vm.previewAgeSec === null ? null : <span>{t.preview.readAge(vm.previewAgeSec)}</span>}
      </RegionEnd>
      <RegionBody>
        <div className="tp-emulators__row">
          <a href={pageHref('dashboard')}>{t.preview.dashboard.short}</a>
        </div>
        {vm.previewState === 'ready' ? null : (
          <div className="tp-emulators__row" data-preview-state={vm.previewState}>
            <Line entry={t.preview.states[vm.previewState]} />
            <Button
              tier="quiet"
              label={t.preview.check.short}
              focusKey="emulators:preview:check"
              onClick={() => {
                commands.checkSettings();
              }}
            />
          </div>
        )}
        {vm.preview === null ? null : (
          <SettingsModuleForm
            vm={vm.preview}
            legend={t.preview.title}
            intro={t.preview.intro}
            onEdit={commands.editDraft}
            onDiscard={commands.discardDraft}
            onSave={(command) => {
              void commands.saveSettings(command);
            }}
            onDismiss={commands.dismiss}
          />
        )}
      </RegionBody>
    </>
  );
}

function NotSent() {
  const vm = useView(selectOutcomes);
  const notice = vm.notices.find((entry) => entry.kind === 'command_not_sent');
  const notSent: Readonly<Record<string, CopyEntry>> = t.notSent;
  const entry = notice === undefined ? undefined : notSent[notice.reason];
  if (notice === undefined || entry === undefined) return null;
  return (
    <div className="tp-emulators__line" data-not-sent={notice.reason} role="status">
      <span>{entry.short}</span>
    </div>
  );
}

/**
 * The Emulators page (emulators brief M1 to M8): this emulator and its live connection,
 * what the last scan detected with its explicit actions, the connection tools, and the
 * saved preview settings. Opening it sends nothing that changes a device or a connection.
 */
export function EmulatorsPage() {
  const { commands } = useDashboard();
  useEffect(() => {
    commands.openEmulators(true);
    return () => {
      commands.openEmulators(false);
    };
  }, [commands]);
  return (
    <>
      <header className="tp-topbar tp-emulators-topbar">
        <RegionBoundary
          fallback={<RevocationFallback part="topBar" />}
          resetKey={useEpochKey()}
          onError={usePartError('topBar')}
        >
          <FaultPoint part="topBar" />
          <TopBar pageId="emulators" title={t.pageName.short} />
        </RegionBoundary>
      </header>
      <main id="main" className="tp-main" tabIndex={-1}>
        <FaultPoint part="page" />
        <div className="tp-emulators">
          <NotSent />
          <EmulatorSettings />
          <EmulatorsRegion id="emulatorsTarget" title={t.target.title}>
            <TargetSection />
          </EmulatorsRegion>
          <EmulatorsRegion id="emulatorsDetected" title={t.detected.title}>
            <DetectedSection />
          </EmulatorsRegion>
          <EmulatorsRegion id="emulatorsTools" title={t.tools.title}>
            <ToolsSection />
          </EmulatorsRegion>
          <EmulatorsRegion id="emulatorsPreview" title={t.preview.title}>
            <PreviewSection />
          </EmulatorsRegion>
        </div>
      </main>
    </>
  );
}
