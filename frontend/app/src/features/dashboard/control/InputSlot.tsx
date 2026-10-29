import { useId } from 'react';
import { copy } from '../../../copy/catalogue.ts';
import { selectInputSlot } from '../../../store/selectors/inputSlot.ts';
import { Button } from '../../../ui/Button.tsx';
import { SlotAction, SlotFacts, SlotMeta } from '../../../ui/Slot.tsx';
import { useDashboard, useView } from '../context.ts';
import { InputFacts, InputOffButton, InputOffReason, InputWhy } from '../shared/InputControl.tsx';

const text = copy.dashboard.control.input;

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
  return (
    <>
      <SlotFacts>
        <InputFacts vm={vm} />
      </SlotFacts>
      <SlotAction>
        <InputOffButton vm={vm} focusKey="input:turn-off" reasonId={reasonId} />
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
        <InputOffReason vm={vm} reasonId={reasonId} />
        <InputWhy vm={vm} />
      </SlotMeta>
    </>
  );
}
