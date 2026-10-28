import { useId } from 'react';
import { copy } from '../../../copy/catalogue.ts';
import type { CopyEntry, CopyText } from '../../../copy/text.ts';
import { selectGemSlot, type GemSlotVM } from '../../../store/selectors/gemSlot.ts';
import { Button } from '../../../ui/Button.tsx';
import { Pill } from '../../../ui/Pill.tsx';
import { pageHref } from '../../../ui/routes.ts';
import { ServerOption, ServerValue } from '../../../ui/ServerValue.tsx';
import { SlotAction, SlotFacts, SlotMeta } from '../../../ui/Slot.tsx';
import { Why } from '../../../ui/Why.tsx';
import { useDashboard, useView } from '../context.ts';
import { codeParam, entryFor, numberParam, SeenLine, staleLine } from './seen.tsx';

const text = copy.dashboard.control.gem;
const shell = copy.dashboard.shell;

function choiceEntry(vm: GemSlotVM): CopyEntry {
  if (vm.choice.qualifier === 'from_before_turn_on') return text.choice.from_before_turn_on;
  return text.choice[vm.choice.word];
}

/** The Seen now line of spec 3.6.2 (G1 to G5g), and its second line when there is one. */
function seenLine(vm: GemSlotVM): {
  readonly line: CopyText;
  readonly extra: CopyText | null;
  readonly why: CopyText | undefined;
} {
  const chip = vm.seen;
  const lines: Readonly<Record<string, CopyEntry>> = text.lines;
  switch (chip.line) {
    case 'last_read':
      return {
        line: staleLine(chip) ?? text.lines.state_unknown.short,
        extra: null,
        why: undefined,
      };
    case 'claims_failing': {
      const streak = numberParam(chip, 'streak');
      return {
        line: streak === null ? text.lines.claims_failing.short : text.claimsFailing(streak),
        extra: null,
        why: text.lines.claims_failing.why,
      };
    }
    case 'collecting_gems':
      return {
        line: text.lines.collecting_gems.short,
        extra:
          chip.params['collectOnly'] === true ? text.lines.started_by_collect_only.short : null,
        why: undefined,
      };
    case 'another_process_holds': {
      const pid = numberParam(chip, 'pid');
      return {
        line: (chip.params['foreign'] === true
          ? text.lines.another_install_holds
          : text.lines.another_process_holds
        ).short,
        extra: pid === null ? null : text.holderPid(pid),
        why: undefined,
      };
    }
    case 'blocked_cause': {
      const cause = entryFor(text.blocked, codeParam(chip, 'code'), text.blocked.other);
      return { line: cause.short, extra: null, why: cause.why };
    }
    case 'retrying_in': {
      const seconds = numberParam(chip, 'seconds');
      return {
        line:
          seconds === null ? text.lines.retry_time_not_reported.short : text.retryingIn(seconds),
        extra: null,
        why: undefined,
      };
    }
    default: {
      const found = entryFor(lines, chip.line, text.lines.state_unknown);
      return { line: found.short, extra: null, why: found.why };
    }
  }
}

/** This battle's confirmations seen and the cause of the latest miss: the backend's values, worded in the catalogue. */
function OutcomesLines({ vm }: { readonly vm: GemSlotVM }) {
  const outcomes = vm.outcomes;
  if (outcomes === null) return null;
  const counts = text.outcomes.counts(
    outcomes.adConfirmations,
    outcomes.orbitConfirmations,
    outcomes.windowsMissed,
  );
  const cause =
    outcomes.cause === null
      ? null
      : text.outcomes.cause(outcomes.cause.code, outcomes.cause.agoSec);
  return (
    <>
      {counts === null ? null : (
        <p className="tp-seen__extra" data-gem-counts="">
          {counts}
        </p>
      )}
      {cause === null ? null : (
        <p className="tp-seen__extra" data-gem-cause={outcomes.cause?.code}>
          {cause}
        </p>
      )}
      {outcomes.finderSuspected === true ? (
        <p className="tp-seen__extra" data-gem-finder-suspected="">
          {text.finderSuspected.short}
        </p>
      ) : null}
    </>
  );
}

/** F-030: this battle's gem toggles, restated as reported (S-036); never a token value. */
function OverlayLine({ vm }: { readonly vm: GemSlotVM }) {
  const overlay = vm.overlay;
  if (overlay === null || overlay.kind !== 'reported') return null;
  const target = (routine: 'ad_gems' | 'floating_gems') =>
    overlay.routines.find((entry) => entry.routine === routine)?.target ?? null;
  const liveChoice = overlay.routines.some((entry) => entry.skipped === 'live_choice');
  const unsupported = overlay.routines.some((entry) => entry.skipped === 'unsupported');
  return (
    <p className="tp-seen__extra" data-overlay={overlay.applied ? 'applied' : 'pending'}>
      <span>{text.overlay.lead.short}</span>
      <span>{text.overlay.routine(target('ad_gems'), target('floating_gems'))}</span>
      <span>{(overlay.applied ? text.overlay.applied : text.overlay.pending).short}</span>
      {liveChoice ? <span>{text.overlay.liveChoice.short}</span> : null}
      {unsupported ? <span>{text.overlay.unsupported.short}</span> : null}
      {overlay.applied ? <span>{text.overlay.ownTiming.short}</span> : null}
    </p>
  );
}

/** The dashboard's start found a collector from before it: the server's code, worded here. */
function CollectorAtStartLine({ vm }: { readonly vm: GemSlotVM }) {
  const found = vm.collectorAtStart;
  if (found === null) return null;
  const words = entryFor(text.collectorAtStart, found.code, text.collectorAtStart.other);
  return (
    <p className="tp-seen__extra" data-collector-at-start={found.code}>
      <span>{words.short}</span>
      {found.pid === null ? null : <span>{text.holderPid(found.pid)}</span>}
    </p>
  );
}

/** F-025, S-080: "Gem settings from {run}: ..." follows the picker's value at once. */
function SourceLine({ vm, id }: { readonly vm: GemSlotVM; readonly id: string }) {
  const source = vm.source;
  if (source.value === null) return null;
  const invalid = vm.cause?.kind === 'source_invalid' && source.isServerSource;
  return (
    <p className="tp-source" id={id}>
      <span>{text.sourcePicker.short}</span>
      {source.label === null ? null : <ServerValue kind="name" value={source.label} />}
      <span className="tp-source__routines">
        {invalid
          ? text.sourceInvalid.short
          : source.policy !== null
            ? text.sourceRoutines(source.policy.adGems, source.policy.floatingGems)
            : source.policyPending
              ? text.sourceNotRead.short
              : text.sourceUnreadable.short}
      </span>
      {vm.sourceChanged ? <span className="tp-seen__extra">{text.sourceChanged.short}</span> : null}
      <a href={pageHref('runs', { kind: 'saved', run: source.value })}>
        {text.savedSettings.short}
      </a>
    </p>
  );
}

/**
 * Control / Gem harvesting (spec 3.6.2, INV-1; F-023 to F-032, F-036): Your
 * choice (a pill, from D-1 alone) and Seen now (a chip, from the gem table
 * alone) side by side but never one input to the other (S-034); Pause
 * harvesting (halt tier) whenever S-001 holds, enabled whenever shown; while
 * the choice is confirmed Off or Not set, the "Gem settings from" picker and
 * Turn on with its reason.
 */
export function GemSlot() {
  const vm = useView(selectGemSlot);
  const { commands } = useDashboard();
  const own = useId();
  const seen = seenLine(vm);
  const choice = choiceEntry(vm);
  const pickerId = `${own}-picker`;
  const sourceId = `${own}-source`;
  const turnOnReasonId = `${own}-turn-on-reason`;
  const againReasonId = `${own}-again-reason`;
  const turnOnReasons: Readonly<Record<string, CopyEntry>> = text.turnOnReasons;
  const reasonOf = (code: string | null) =>
    entryFor(turnOnReasons, code, text.turnOnReasons.choice_unknown);
  const turnOnCommand = vm.turnOn.command;
  const againCommand = vm.turnOnAgain.command;
  return (
    <>
      <SlotFacts>
        <Pill prefix={shell.pills.yourChoice.short} value={choice.short} />
        <SeenLine chip={vm.seen} line={seen.line} extra={seen.extra} />
        <OutcomesLines vm={vm} />
        <OverlayLine vm={vm} />
      </SlotFacts>
      <SlotAction>
        {vm.pause.shown ? (
          <Button
            tier="halt"
            label={shell.revocations.pause.short}
            focusKey="gem:pause"
            busy={vm.pause.sending}
            onClick={() => {
              void commands.pause();
            }}
          />
        ) : null}
        {vm.source.pickerShown && vm.source.choices.length > 0 ? (
          <span className="tp-picker">
            <label htmlFor={pickerId}>{text.sourcePicker.short}</label>
            <select
              id={pickerId}
              data-focus-key="gem:source"
              value={vm.source.value ?? ''}
              aria-describedby={sourceId}
              onChange={(event) => {
                commands.selectGemSource(event.currentTarget.value);
              }}
            >
              {vm.source.choices.map((choiceOption) =>
                choiceOption.label === null ? (
                  <option key={choiceOption.key} value={choiceOption.key}>
                    {text.unnamedRun.short}
                  </option>
                ) : (
                  <ServerOption
                    key={choiceOption.key}
                    value={choiceOption.key}
                    label={choiceOption.label}
                  />
                ),
              )}
            </select>
          </span>
        ) : null}
        {vm.turnOn.shown && vm.source.pickerShown ? (
          vm.turnOn.enabled && turnOnCommand !== null ? (
            <Button
              tier="secondary"
              label={text.turnOn.short}
              focusKey="gem:turn-on"
              busy={vm.turnOn.sending}
              describedBy={sourceId}
              onClick={() => {
                void commands.turnOn(turnOnCommand);
              }}
            />
          ) : (
            <>
              <Button
                tier="secondary"
                label={text.turnOn.short}
                focusKey="gem:turn-on"
                busy={vm.turnOn.sending}
                disabled
                reasonId={turnOnReasonId}
                onClick={() => undefined}
              />
              <span id={turnOnReasonId} className="tp-reason">
                {reasonOf(vm.turnOn.reason).short}
              </span>
            </>
          )
        ) : null}
        {vm.turnOnAgain.shown ? (
          vm.turnOnAgain.enabled && againCommand !== null ? (
            <Button
              tier="secondary"
              label={text.turnOnAgain.short}
              focusKey="gem:turn-on-again"
              busy={vm.turnOnAgain.sending}
              onClick={() => {
                void commands.turnOn(againCommand);
              }}
            />
          ) : (
            <>
              <Button
                tier="secondary"
                label={text.turnOnAgain.short}
                focusKey="gem:turn-on-again"
                disabled
                reasonId={againReasonId}
                onClick={() => undefined}
              />
              <span id={againReasonId} className="tp-reason">
                {reasonOf(vm.turnOnAgain.reason).short}
              </span>
            </>
          )
        ) : null}
      </SlotAction>
      <SlotMeta>
        <SourceLine vm={vm} id={sourceId} />
        <CollectorAtStartLine vm={vm} />
        {vm.cause?.message === null || vm.cause === null ? null : (
          <details className="tp-copy-line__why">
            <summary>{copy.common.why.short}</summary>
            <ServerValue kind="message" value={vm.cause.message} />
          </details>
        )}
        <Why why={seen.why} />
      </SlotMeta>
    </>
  );
}
