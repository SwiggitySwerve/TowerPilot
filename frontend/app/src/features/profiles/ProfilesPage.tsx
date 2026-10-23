import { EditingTargetPicker } from './EditingTargetPicker.tsx';
import { editingTarget as targetCopy } from '../../copy/editingTarget.ts';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { profiles as t } from '../../copy/profiles.ts';
import type { CopyEntry, CopyNode } from '../../copy/text.ts';
import {
  selectProfilesPage,
  type ProfileRowVM,
  type ProfilesSectionVM,
  type ValidationVM,
} from '../../store/selectors/profiles.ts';
import type { ProfileWriteCommand } from '../../store/commands.ts';
import type { CommandVM } from '../../store/viewModels.ts';
import { Button } from '../../ui/Button.tsx';
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx';
import { Disclosure } from '../../ui/Disclosure.tsx';
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
import { RevocationFallback } from '../dashboard/shared/RevocationFallback.tsx';
import { TopBar } from '../dashboard/topBar/TopBar.tsx';
import { ProfileOutcome } from './ProfileOutcome.tsx';
import './profiles.css';

const RECOGNITION = '/ui/index.html#screens';
const EMULATORS = '/ui/index.html#emulators';

function reasonOf(reason: string | null): CopyEntry {
  const reasons: Readonly<Record<string, CopyEntry>> = t.reasons;
  return (reason === null ? undefined : reasons[reason]) ?? t.reasons.context_unknown;
}

/** One write button: enabled with its command, or disabled with its visible reason. */
function WriteButton({
  vm,
  label,
  focusKey,
  onSend,
  tier = 'secondary',
}: {
  readonly vm: CommandVM<ProfileWriteCommand>;
  readonly label: CopyEntry;
  readonly focusKey: string;
  readonly onSend: (command: ProfileWriteCommand) => void;
  readonly tier?: 'secondary' | 'quiet';
}) {
  const own = useId();
  const { command } = vm;
  return (
    <span className="tp-profiles__action">
      {vm.enabled && command !== null ? (
        <Button
          tier={tier}
          label={label.short}
          focusKey={focusKey}
          onClick={() => {
            onSend(command);
          }}
        />
      ) : (
        <>
          <Button
            tier={tier}
            label={label.short}
            focusKey={focusKey}
            busy={vm.sending}
            disabled
            reasonId={`${own}-reason`}
            onClick={() => undefined}
          />
          <span id={`${own}-reason`} className="tp-reason">
            {reasonOf(vm.reason).short}
          </span>
        </>
      )}
    </span>
  );
}

function TextField({
  label,
  value,
  scope,
  path,
  help,
  invalid,
}: {
  readonly label: CopyEntry;
  readonly value: string;
  readonly scope: string | null;
  readonly path: string;
  readonly help?: CopyEntry;
  readonly invalid?: CopyEntry | null;
}) {
  const { commands } = useDashboard();
  const own = useId();
  const described = [help === undefined ? null : `${own}-help`, invalid ? `${own}-invalid` : null]
    .filter((entry) => entry !== null)
    .join(' ');
  return (
    <label className="tp-profiles__field">
      <span>{label.short}</span>
      <input
        type="text"
        className="tp-profiles__input"
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={scope === null}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={described === '' ? undefined : described}
        data-focus-key={`${scope ?? 'none'}:${path}`}
        onChange={(event) => {
          if (scope !== null) commands.editDraft(scope, path, event.currentTarget.value);
        }}
      />
      {help === undefined ? null : (
        <span id={`${own}-help`} className="tp-profiles__help">
          {help.short}
        </span>
      )}
      {invalid ? (
        <span id={`${own}-invalid`} className="tp-profiles__invalid">
          {invalid.short}
        </span>
      ) : null}
    </label>
  );
}

function CheckField({
  label,
  checked,
  scope,
  path,
  consent,
}: {
  readonly label: CopyEntry;
  readonly checked: boolean;
  readonly scope: string | null;
  readonly path: string;
  /** Record this key when ticked (consent for one reviewed write), '' when cleared. */
  readonly consent?: string;
}) {
  const { commands } = useDashboard();
  return (
    <span className="tp-profiles__check">
      <label>
        <input
          type="checkbox"
          checked={checked}
          disabled={scope === null}
          data-focus-key={`${scope ?? 'none'}:${path}`}
          onChange={(event) => {
            if (scope === null) return;
            const ticked = event.currentTarget.checked;
            commands.editDraft(scope, path, consent === undefined ? ticked : ticked ? consent : '');
          }}
        />
        <span>{label.short}</span>
      </label>
      {label.why === undefined ? null : <Why why={label.why} />}
    </span>
  );
}

function ProfileSelect({
  label,
  value,
  rows,
  scope,
  path,
  empty,
  onPick,
}: {
  readonly label: CopyEntry;
  readonly value: string;
  readonly rows: readonly ProfileRowVM[];
  readonly scope: string | null;
  readonly path: string;
  readonly empty: CopyEntry;
  readonly onPick?: (name: string) => void;
}) {
  const { commands } = useDashboard();
  return (
    <label className="tp-profiles__field">
      <span>{label.short}</span>
      <select
        value={value}
        disabled={scope === null}
        data-focus-key={`${scope ?? 'none'}:${path}`}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (scope !== null) commands.editDraft(scope, path, next);
          onPick?.(next);
        }}
      >
        {rows.some((row) => row.key === value) ? null : <option value="">{empty.short}</option>}
        {rows.map((row) =>
          row.name === null ? null : (
            <ServerOption key={row.key} value={row.key} label={row.name} />
          ),
        )}
      </select>
    </label>
  );
}

function Validation({ validation }: { readonly validation: ValidationVM }) {
  return (
    <div className="tp-profiles__validation" data-validation="true">
      {validation.validatorError !== null ? (
        <span data-validator-error="true">
          <span>{t.files.validatorUnavailable.short}</span>
          <ServerValue kind="message" value={validation.validatorError} />
        </span>
      ) : validation.problems.length === 0 ? (
        <span>{t.files.valid.short}</span>
      ) : (
        <Disclosure label={t.files.problems(validation.problems.length)}>
          <ul className="tp-profile-problems">
            {validation.problems.map((problem, index) => (
              <li key={String(index)}>
                <ServerValue kind="message" value={problem} />
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {validation.warnings.length === 0 ? null : (
        <Disclosure label={t.files.warnings(validation.warnings.length)}>
          <ul className="tp-profile-problems">
            {validation.warnings.map((warning, index) => (
              <li key={String(index)}>
                <ServerValue kind="message" value={warning} />
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}

function ProfilesRegion({
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
      fallback={<RevocationFallback part="profiles" />}
      resetKey={useEpochKey()}
      onError={usePartError(id)}
    >
      <FaultPoint part={id} />
      {children}
    </Region>
  );
}

/**
 * F6-14 PE1 (classic Active selector "none - legacy constants"): unbind the active profile,
 * behind a confirmation. An explicit action beside Activate, never an empty picker option.
 */
function UnbindProfile({
  unbind,
  onSend,
}: {
  readonly unbind: NonNullable<ProfilesSectionVM['unbind']>;
  readonly onSend: (command: ProfileWriteCommand) => void;
}) {
  const own = useId();
  const [asking, setAsking] = useState<ProfileWriteCommand | null>(null);
  const { command } = unbind.command;
  // The confirmation applies only to the context it was opened in (a context change closes it).
  const current =
    asking !== null && command !== null && asking.epoch === command.epoch ? command : null;
  if (asking !== null && current === null) setAsking(null);
  return (
    <fieldset className="tp-profiles__form" data-form="unbind">
      <legend>{t.unbind.title.short}</legend>
      <div className="tp-profiles__row">
        <p className="tp-profiles__summary">
          <span>{t.unbind.active.short}</span>
          {unbind.active === null ? (
            <span>{t.unbind.none.short}</span>
          ) : (
            <ServerValue kind="name" value={unbind.active} />
          )}
        </p>
        {unbind.command.enabled && command !== null ? (
          <Button
            tier="quiet"
            label={t.unbind.submit.short}
            focusKey="profiles:unbind:submit"
            onClick={() => {
              setAsking(command);
            }}
          />
        ) : (
          <span className="tp-profiles__action">
            <Button
              tier="quiet"
              label={t.unbind.submit.short}
              focusKey="profiles:unbind:submit"
              busy={unbind.command.sending}
              disabled
              reasonId={`${own}-reason`}
              onClick={() => undefined}
            />
            <span id={`${own}-reason`} className="tp-reason">
              {reasonOf(unbind.command.reason).short}
            </span>
          </span>
        )}
        {t.unbind.submit.why === undefined ? null : <Why why={t.unbind.submit.why} />}
      </div>
      {unbind.outcome === null ? null : <ProfileOutcome outcome={unbind.outcome} />}
      <ConfirmDialog
        open={current !== null}
        tier="primary"
        title={t.unbind.confirm.short}
        body={
          <div>
            <p>{t.unbind.effect.short}</p>
            <div className="tp-profiles__summary">
              <span>{t.unbind.account.short}</span>
              {unbind.account === null ? (
                <span>{t.unbind.installation.short}</span>
              ) : (
                <ServerValue kind="name" value={unbind.account} />
              )}
            </div>
            <div className="tp-profiles__summary">
              <span>{t.unbind.emulator.short}</span>
              {unbind.instance === null ? null : (
                <ServerValue kind="name" value={unbind.instance} />
              )}
            </div>
            <div className="tp-profiles__summary">
              <span>{t.unbind.profile.short}</span>
              {unbind.active === null ? null : <ServerValue kind="name" value={unbind.active} />}
            </div>
          </div>
        }
        confirmLabel={t.unbind.send.short}
        cancelLabel={t.unbind.cancel.short}
        onCancel={() => {
          setAsking(null);
        }}
        onConfirm={() => {
          setAsking(null);
          if (current !== null) onSend(current);
        }}
      />
    </fieldset>
  );
}

/** P1, P2: the emulator's local account, the switch, and a new account. */
function AccountSection() {
  const vm = useView(selectProfilesPage);
  const { commands } = useDashboard();
  const account = vm.account;
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const question = useId();
  /** Close the switch question and give focus back to the button that opened it. */
  const closeConfirm = useCallback(() => {
    setConfirming(false);
    rowRef.current?.querySelector<HTMLElement>('[data-focus-key="profiles:account:use"]')?.focus();
  }, []);
  useEffect(() => {
    const box = confirmRef.current;
    if (!confirming || box === null) return undefined;
    box.querySelector('button')?.focus();
    // Escape closes the question like Cancel.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeConfirm();
    };
    box.addEventListener('keydown', onKey);
    return () => {
      box.removeEventListener('keydown', onKey);
    };
  }, [confirming, closeConfirm]);
  const keeps = account.keeps.edits + account.keeps.unresolved;
  const send = (command: ProfileWriteCommand) => {
    void commands.profileWrite(command);
  };
  return (
    <>
      <RegionEnd>
        {account.readAgeSec === null ? null : <span>{t.account.readAge(account.readAgeSec)}</span>}
      </RegionEnd>
      <RegionBody>
        <div className="tp-profiles__scope">
          <span>{t.account.scope.short}</span>
          <Why why={t.account.scope.why} />
        </div>
        <p className="tp-profiles__summary">
          <span>{t.account.emulator.short}</span>
          {account.instance === null ? null : <ServerValue kind="id" value={account.instance} />}
        </p>
        {account.read === 'not_read' ? <p>{t.account.reading.short}</p> : null}
        {account.read === 'settling' ? <p>{t.account.settling.short}</p> : null}
        {account.read === 'unavailable' ? <p>{t.account.unavailable.short}</p> : null}
        {account.read === 'ready' ? (
          <p className="tp-profiles__summary" data-active-account="true">
            {account.active === null ? (
              <span>{t.account.noneActive.short}</span>
            ) : (
              <>
                <span>{t.account.inUse.short}</span>
                {account.active.label === null ? null : (
                  <ServerValue kind="name" value={account.active.label} />
                )}
                {account.active.id === null ? null : (
                  <ServerValue kind="id" value={account.active.id} />
                )}
              </>
            )}
          </p>
        ) : null}
        {account.read === 'ready' && account.accounts.length === 0 ? (
          <p>{t.account.noAccounts.short}</p>
        ) : null}
        {account.accounts.length === 0 ? null : (
          <div className="tp-profiles__row" ref={rowRef}>
            <label className="tp-profiles__field">
              <span>{t.account.picker.short}</span>
              <select
                value={account.pick ?? ''}
                disabled={account.pickScope === null}
                data-focus-key="profiles:account:pick"
                onChange={(event) => {
                  setConfirming(false);
                  if (account.pickScope !== null)
                    commands.editDraft(account.pickScope, 'id', event.currentTarget.value);
                }}
              >
                {account.pick === null ? (
                  <option value="">{t.reasons.choose_account.short}</option>
                ) : null}
                {account.accounts.map((choice) =>
                  choice.option === null ? null : (
                    <ServerOption key={choice.key} value={choice.key} label={choice.option} />
                  ),
                )}
              </select>
            </label>
            <WriteButton
              vm={account.select}
              label={t.account.use}
              focusKey="profiles:account:use"
              onSend={(command) => {
                if (keeps > 0) setConfirming(true);
                else send(command);
              }}
            />
          </div>
        )}
        {confirming && account.select.command !== null ? (
          <div
            ref={confirmRef}
            className="tp-profiles__confirm"
            role="group"
            aria-labelledby={question}
            data-switch-confirm="true"
          >
            <p id={question}>{t.account.keeps(account.keeps.edits, account.keeps.unresolved)}</p>
            <Button
              tier="secondary"
              label={t.account.confirmSwitch.short}
              focusKey="profiles:account:confirm"
              onClick={() => {
                const command = account.select.command;
                closeConfirm();
                if (command !== null) send(command);
              }}
            />
            <Button
              tier="quiet"
              label={t.account.cancel.short}
              focusKey="profiles:account:cancel"
              onClick={closeConfirm}
            />
          </div>
        ) : null}
        {account.outcome === null ? null : <ProfileOutcome outcome={account.outcome} />}
        <fieldset className="tp-profiles__form" data-form="create">
          <legend>{t.create.title.short}</legend>
          <TextField
            label={t.create.id}
            value={account.create.id}
            scope={account.create.scope}
            path="id"
            help={t.create.idHelp}
          />
          <TextField
            label={t.create.label}
            value={account.create.label}
            scope={account.create.scope}
            path="label"
          />
          {account.create.importOffered ? (
            <CheckField
              label={t.create.importCurrent}
              checked={account.create.importCurrent}
              scope={account.create.scope}
              path="import_current"
            />
          ) : null}
          <div className="tp-profiles__actions">
            <WriteButton
              vm={account.create.command}
              label={t.create.submit}
              focusKey="profiles:create:submit"
              onSend={send}
            />
          </div>
        </fieldset>
      </RegionBody>
    </>
  );
}

/** P3: the operator's highest unlocked tier. */
function TierSection() {
  const vm = useView(selectProfilesPage);
  const { commands } = useDashboard();
  const tier = vm.tier;
  return (
    <RegionBody>
      <p className="tp-profiles__summary" data-tier-saved="true">
        {tier.current !== null ? (
          <>
            <span>{t.tier.current.short}</span>
            <span>{t.tier.value(tier.current)}</span>
          </>
        ) : tier.defaultValue !== null ? (
          <>
            <span>{t.tier.default.short}</span>
            <span>{t.tier.value(tier.defaultValue)}</span>
            <span>{t.tier.defaultNote.short}</span>
          </>
        ) : (
          <span>{t.tier.notSaved.short}</span>
        )}
        {tier.current === null ? null : tier.setBy === 'operator' ? (
          <span>{t.tier.byOperator.short}</span>
        ) : tier.setBy === 'other' && tier.setByText !== null ? (
          <span>
            <span>{t.tier.byOther.short}</span>
            <ServerValue kind="id" value={tier.setByText} />
          </span>
        ) : (
          <span>{t.tier.sourceUnknown.short}</span>
        )}
      </p>
      <div className="tp-profiles__row">
        <TextField
          label={t.tier.input}
          value={tier.shown}
          scope={tier.scope}
          path="max_tier"
          help={t.tier.range}
          invalid={tier.invalid === null ? null : t.tier.invalid[tier.invalid]}
        />
        <WriteButton
          vm={tier.save}
          label={t.tier.save}
          focusKey="profiles:tier:save"
          onSend={(command) => {
            void commands.profileWrite(command);
          }}
        />
      </div>
      {tier.outcome === null ? null : <ProfileOutcome outcome={tier.outcome} />}
    </RegionBody>
  );
}

/** P4: the setup reads, each distinct, with links to the pages that own them. */
function SetupSection() {
  const vm = useView(selectProfilesPage);
  const setup = vm.setup;
  return (
    <RegionBody>
      <ul className="tp-profiles__setup">
        <li data-setup="tools" data-state={setup.tools}>
          <span>{t.setup.tools[setup.tools].short}</span>
          <a href={EMULATORS}>{t.setup.emulators.short}</a>
        </li>
        <li data-setup="calibration" data-state={setup.calibration}>
          <span>{t.setup.calibration[setup.calibration].short}</span>
        </li>
        <li data-setup="runs">
          <span>
            {setup.runs === null
              ? t.setup.runsUnknown.short
              : t.setup.runs(setup.runs.ready, setup.runs.notReady, setup.runs.unknown)}
          </span>
          <a href={RECOGNITION}>{t.setup.recognition.short}</a>
        </li>
      </ul>
      <div className="tp-profiles__scope">
        <span>{t.setup.note.short}</span>
        <Why why={t.setup.note.why} />
      </div>
    </RegionBody>
  );
}

/** P5: the profile files, activation, copies and scan-draft promotions. */
function FilesSection() {
  const vm = useView(selectProfilesPage);
  const { commands } = useDashboard();
  const files = vm.profiles;
  const send = (command: ProfileWriteCommand) => {
    void commands.profileWrite(command);
  };
  return (
    <RegionBody>
      <div className="tp-profiles__scope">
        <span>{t.files.scope.short}</span>
        <Why why={t.files.scope.why} />
      </div>
      <div className="tp-profiles__summary" data-active-profile="true">
        <span>{t.files.active.short}</span>
        {files.active === null ? (
          <span>{t.files.noActive.short}</span>
        ) : (
          <ServerValue kind="name" value={files.active} />
        )}
        {files.activeValidation === null ? (
          files.activeSourceError === null ? null : (
            <span>
              <span>{t.files.sourceUnavailable.short}</span>
              <ServerValue kind="message" value={files.activeSourceError} />
            </span>
          )
        ) : (
          <Validation validation={files.activeValidation} />
        )}
      </div>
      {files.read === 'not_read' ? <p>{t.files.reading.short}</p> : null}
      {files.read === 'settling' ? <p>{t.files.settling.short}</p> : null}
      {files.read === 'unavailable' ? <p>{t.files.unavailable.short}</p> : null}
      {files.read === 'ready' && files.rows.length === 0 ? <p>{t.files.none.short}</p> : null}
      {files.rows.length === 0 ? null : (
        <table className="tp-profiles__table">
          <thead>
            <tr>
              <th scope="col">{t.files.columns.name.short}</th>
              <th scope="col">{t.files.columns.kind.short}</th>
              <th scope="col">{t.files.columns.modified.short}</th>
            </tr>
          </thead>
          <tbody>
            {files.rows.map((row) => (
              <tr key={row.key} data-profile={row.key} data-active={row.active}>
                <td>
                  {row.name === null ? null : <ServerValue kind="name" value={row.name} />}
                  {row.active ? (
                    <span className="tp-profiles__mark">{t.files.activeMark.short}</span>
                  ) : null}
                </td>
                <td>
                  <span>
                    <span>{t.files.kinds[row.kind].short}</span>
                    {row.note === null ? null : (
                      <span className="tp-profiles__help">
                        <ServerValue kind="message" value={row.note} />
                      </span>
                    )}
                  </span>
                </td>
                <td>
                  {row.mtime === null ? t.files.modifiedUnknown.short : t.files.modified(row.mtime)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <fieldset className="tp-profiles__form" data-form="automation">
        <legend>{targetCopy.automation.short}</legend>
        <fieldset className="tp-profiles__form" data-form="activate">
          <legend>{t.activate.title.short}</legend>
          <div className="tp-profiles__row">
            <ProfileSelect
              label={t.activate.picker}
              value={files.activate.pick ?? ''}
              rows={files.rows}
              scope={files.activate.scope}
              path="name"
              empty={t.activate.choose}
              onPick={(name) => {
                if (name !== '') void commands.checkProfile(name);
              }}
            />
            <WriteButton
              vm={files.activate.command}
              label={t.activate.submit}
              focusKey="profiles:activate:submit"
              onSend={send}
            />
          </div>
          {files.activate.check === 'checking' ? <p>{t.activate.checking.short}</p> : null}
          {files.activate.validation === null ? null : (
            <Validation validation={files.activate.validation} />
          )}
          {files.activate.checkError === null ? null : (
            <p>
              <span>{t.reasons.unreadable.short}</span>
              <ServerValue kind="message" value={files.activate.checkError} />
            </p>
          )}
          {files.activate.outcome === null ? null : (
            <ProfileOutcome outcome={files.activate.outcome} />
          )}
        </fieldset>
        {files.unbind === null ? null : <UnbindProfile unbind={files.unbind} onSend={send} />}
      </fieldset>
      <EditingTargetPicker key={vm.epoch} />
      <fieldset className="tp-profiles__form" data-form="copy">
        <legend>{t.copy.title.short}</legend>
        <div className="tp-profiles__row">
          <ProfileSelect
            label={t.copy.from}
            value={files.copy.from}
            rows={files.copy.sources}
            scope={files.copy.scope}
            path="from"
            empty={t.reasons.choose_source}
          />
          <TextField
            label={t.copy.name}
            value={files.copy.name}
            scope={files.copy.scope}
            path="name"
          />
        </div>
        {files.copy.exists ? (
          <CheckField
            label={t.copy.overwrite}
            checked={files.copy.overwrite}
            scope={files.copy.scope}
            path="overwrite"
            consent={files.copy.overwriteKey}
          />
        ) : null}
        <div className="tp-profiles__actions">
          <WriteButton
            vm={files.copy.command}
            label={t.copy.submit}
            focusKey="profiles:copy:submit"
            onSend={send}
          />
        </div>
      </fieldset>
      <fieldset className="tp-profiles__form" data-form="promote">
        <legend>{t.promote.title.short}</legend>
        <div className="tp-profiles__row">
          <ProfileSelect
            label={t.promote.draft}
            value={files.promote.draft}
            rows={files.promote.drafts}
            scope={files.promote.scope}
            path="draft"
            empty={t.promote.noDrafts}
          />
          <TextField
            label={t.promote.name}
            value={files.promote.name}
            scope={files.promote.scope}
            path="name"
          />
          <ProfileSelect
            label={t.promote.base}
            value={files.promote.base}
            rows={files.promote.bases}
            scope={files.promote.scope}
            path="base"
            empty={t.reasons.choose_source}
          />
        </div>
        {files.promote.exists ? (
          <CheckField
            label={t.promote.overwrite}
            checked={files.promote.overwrite}
            scope={files.promote.scope}
            path="overwrite"
            consent={files.promote.overwriteKey}
          />
        ) : null}
        <div className="tp-profiles__actions">
          <WriteButton
            vm={files.promote.command}
            label={t.promote.submit}
            focusKey="profiles:promote:submit"
            onSend={send}
          />
        </div>
      </fieldset>
      {files.filesOutcome === null ? null : <ProfileOutcome outcome={files.filesOutcome} />}
    </RegionBody>
  );
}

function NotSent() {
  const vm = useView(selectProfilesPage);
  if (vm.notSent === null) return null;
  const notSent: Readonly<Record<string, CopyEntry>> = t.notSent;
  const entry = notSent[vm.notSent];
  if (entry === undefined) return null;
  return (
    <div className="tp-profiles__not-sent" data-not-sent={vm.notSent} role="status">
      <span>{entry.short}</span>
      {entry.why === undefined ? null : <Why why={entry.why} />}
    </div>
  );
}

/**
 * The Profiles page (profiles brief P1 to P5): the local game account bound
 * to this emulator, the operator's tier, the setup state, and the automation
 * profiles. Opening it tells the store to read the profile files and the
 * active profile; every write goes through app/'s click-time context fence.
 */
export function ProfilesPage() {
  const { commands } = useDashboard();
  useEffect(() => {
    commands.openProfiles(true);
    return () => {
      commands.openProfiles(false);
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
        <div className="tp-profiles">
          <NotSent />
          <ProfilesRegion id="profilesAccount" title={t.account.title}>
            <AccountSection />
          </ProfilesRegion>
          <ProfilesRegion id="profilesTier" title={t.tier.title}>
            <TierSection />
          </ProfilesRegion>
          <ProfilesRegion id="profilesFiles" title={t.files.title}>
            <FilesSection />
          </ProfilesRegion>
          <ProfilesRegion id="profilesSetup" title={t.setup.title}>
            <SetupSection />
          </ProfilesRegion>
        </div>
      </main>
    </>
  );
}
