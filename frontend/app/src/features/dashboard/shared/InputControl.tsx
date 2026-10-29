import { copy } from '../../../copy/catalogue.ts';
import type { CopyEntry } from '../../../copy/text.ts';
import type { InputSlotVM } from '../../../store/selectors/inputSlot.ts';
import { Button } from '../../../ui/Button.tsx';
import { Pill } from '../../../ui/Pill.tsx';
import { Why } from '../../../ui/Why.tsx';
import { useDashboard } from '../context.ts';
import { listParam, SeenLine } from '../control/seen.tsx';

const text = copy.dashboard.control.input;
const shell = copy.dashboard.shell;
const lines: Readonly<Record<string, CopyEntry>> = text.lines;

function settingEntry(vm: InputSlotVM): CopyEntry {
  if (!vm.setting.known) return text.setting.unknown;
  return vm.setting.allowed ? text.setting.allowed : text.setting.off;
}

/** Permission and observed evidence stay distinct in every input-control placement. */
export function InputFacts({ vm }: { readonly vm: InputSlotVM }) {
  const steps = listParam(vm.seen, 'steps');
  const collectors = listParam(vm.seen, 'collectors');
  const lineText =
    vm.seen.line === 'turn_off_not_confirmed_for'
      ? text.notConfirmedFor(collectors.length)
      : vm.seen.line === 'turn_off_step_failed'
        ? text.stepFailed(steps[0] ?? 'unknown_step')
        : (lines[vm.seen.line] ?? text.lines.cant_tell_whats_running).short;
  return (
    <>
      <Pill prefix={shell.pills.setting.short} value={settingEntry(vm).short} />
      <SeenLine chip={vm.seen} line={lineText} />
      {steps.slice(1).map((step) => (
        <span key={step} className="tp-seen__extra">
          {text.stepFailed(step)}
        </span>
      ))}
    </>
  );
}

/** The selector owns offering and busy state; each click remains a fresh revocation. */
export function InputOffButton({
  vm,
  focusKey,
  reasonId,
}: {
  readonly vm: InputSlotVM;
  readonly focusKey: string;
  readonly reasonId: string;
}) {
  const { commands } = useDashboard();
  return vm.turnOff.shown ? (
    <Button
      tier="halt"
      label={shell.revocations.turnInputOff.short}
      focusKey={focusKey}
      busy={vm.turnOff.sending}
      {...(vm.offReason === null ? {} : { describedBy: reasonId })}
      onClick={() => {
        void commands.turnInputOff();
      }}
    />
  ) : null;
}

export function InputOffReason({
  vm,
  reasonId,
}: {
  readonly vm: InputSlotVM;
  readonly reasonId: string;
}) {
  return vm.turnOff.shown && vm.offReason !== null ? (
    <span id={reasonId} className="tp-reason">
      {text.offReasons[vm.offReason].short}
    </span>
  ) : null;
}

export function InputWhy({ vm }: { readonly vm: InputSlotVM }) {
  return <Why why={lines[vm.seen.line]?.why} />;
}
