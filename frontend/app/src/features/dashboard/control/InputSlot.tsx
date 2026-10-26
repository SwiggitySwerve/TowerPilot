import { useId } from 'react';
import { copy } from '../../../copy/catalogue.ts';
import type { CopyEntry } from '../../../copy/text.ts';
import { selectInputSlot, type InputSlotVM } from '../../../store/selectors/inputSlot.ts';
import { Button } from '../../../ui/Button.tsx';
import { Pill } from '../../../ui/Pill.tsx';
import { SlotAction, SlotFacts, SlotMeta } from '../../../ui/Slot.tsx';
import { Why } from '../../../ui/Why.tsx';
import { useDashboard, useView } from '../context.ts';
import { listParam, SeenLine } from './seen.tsx';

const text = copy.dashboard.control.input;
const shell = copy.dashboard.shell;

function settingEntry(vm: InputSlotVM): CopyEntry {
  if (!vm.setting.known) return text.setting.unknown;
  return vm.setting.allowed ? text.setting.allowed : text.setting.off;
}

/**
 * Control / Game input (spec 3.6.3, INV-2; F-017, F-018, F-020, F-022): the
 * Setting pill (a choice, never evidence), the Seen now chip, Turn input off
 * (halt tier, rendered and enabled whenever input may be on or unknown; every
 * click is a new request) with its one-line reason, and Allow game input only
 * while the Setting reads Off and a fresh read shows no owner.
 */
export function InputSlot() {
  const vm = useView(selectInputSlot);
  const { commands } = useDashboard();
  const own = useId();
  const reasonId = `${own}-reason`;
  const setting = settingEntry(vm);
  const lines: Readonly<Record<string, CopyEntry>> = text.lines;
  const steps = listParam(vm.seen, 'steps');
  const collectors = listParam(vm.seen, 'collectors');
  const lineText =
    vm.seen.line === 'turn_off_not_confirmed_for'
      ? text.notConfirmedFor(collectors.length)
      : vm.seen.line === 'turn_off_step_failed'
        ? text.stepFailed(steps[0] ?? 'unknown_step')
        : (lines[vm.seen.line] ?? text.lines.cant_tell_whats_running).short;
  const why = lines[vm.seen.line]?.why;
  return (
    <>
      <SlotFacts>
        <Pill prefix={shell.pills.setting.short} value={setting.short} />
        <SeenLine chip={vm.seen} line={lineText} />
        {steps.slice(1).map((step) => (
          <span key={step} className="tp-seen__extra">
            {text.stepFailed(step)}
          </span>
        ))}
      </SlotFacts>
      <SlotAction>
        {vm.turnOff.shown ? (
          <Button
            tier="halt"
            label={shell.revocations.turnInputOff.short}
            focusKey="input:turn-off"
            busy={vm.turnOff.sending}
            {...(vm.offReason === null ? {} : { describedBy: reasonId })}
            onClick={() => {
              void commands.turnInputOff();
            }}
          />
        ) : null}
        {vm.allow.shown ? (
          vm.allow.enabled ? (
            <Button
              tier="secondary"
              label={text.allow.short}
              focusKey="input:allow"
              onClick={() => {
                void commands.allowInput();
              }}
            />
          ) : (
            <>
              <Button
                tier="secondary"
                label={text.allow.short}
                focusKey="input:allow"
                busy={vm.allow.sending}
                disabled
                reasonId={`${own}-allow`}
                onClick={() => undefined}
              />
              <span id={`${own}-allow`} className="tp-reason">
                {text.allowReasons.request_in_flight.short}
              </span>
            </>
          )
        ) : null}
      </SlotAction>
      <SlotMeta>
        {vm.turnOff.shown && vm.offReason !== null ? (
          <span id={reasonId} className="tp-reason">
            {text.offReasons[vm.offReason].short}
          </span>
        ) : null}
        <Why why={why} />
      </SlotMeta>
    </>
  );
}
