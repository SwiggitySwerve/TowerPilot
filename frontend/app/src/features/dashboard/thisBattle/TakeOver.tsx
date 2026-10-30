import { useId, useState } from 'react';
import { copy } from '../../../copy/catalogue.ts';
import type { CopyEntry } from '../../../copy/text.ts';
import { ownOr } from '../../../core/read.ts';
import { selectTakeover } from '../../../store/selectors/takeover.ts';
import { ActionRow, Reason } from '../../../ui/ActionRow.tsx';
import { Button } from '../../../ui/Button.tsx';
import { ConfirmDialog } from '../../../ui/ConfirmDialog.tsx';
import { RegionBody } from '../../../ui/Region.tsx';
import { ServerValue } from '../../../ui/ServerValue.tsx';
import { useDashboard, useView } from '../context.ts';

const words = copy.dashboard.thisBattle.takeover;
const reasons = copy.dashboard.startNext.reasons;

/** The words of a disabled reason: Start next's own, since a takeover is gated like a Start. */
function reasonEntry(code: string, guardCode: string | null): CopyEntry {
  if (
    (code === 'guard_blocks' || code === 'guard_unconfirmed') &&
    guardCode === 'setup_battle_unresolved'
  )
    return reasons.setup_battle_unresolved;
  return ownOr(reasons, code, reasons.guard_unconfirmed);
}

/**
 * Take over the battle on screen, shown when nothing tracks or owns a battle (store/selectors/
 * takeover.ts). The click only opens the confirmation; the confirm sends one request, whose
 * answer and the server's own words about it appear with the other request results, and "Taken
 * over" appears in the battle header only once the server says the worker read the battle.
 */
export function TakeOver() {
  const vm = useView(selectTakeover);
  const { commands } = useDashboard();
  const [asking, setAsking] = useState(false);
  const reasonId = useId();
  const { takeover } = vm;
  if (!takeover.shown) return null;
  const blocked = takeover.reason !== null;
  return (
    <RegionBody>
      <ActionRow
        reason={
          takeover.reason === null ? undefined : (
            <Reason id={reasonId} entry={reasonEntry(takeover.reason, vm.guardCode)} />
          )
        }
      >
        <Button
          tier="secondary"
          label={words.action.short}
          focusKey="battle-takeover"
          busy={takeover.sending}
          {...(blocked ? { disabled: true, reasonId } : {})}
          onClick={() => {
            setAsking(true);
          }}
        />
      </ActionRow>
      <ConfirmDialog
        open={asking}
        tier="primary"
        title={words.title.short}
        body={
          <>
            <p>{words.body.short}</p>
            {vm.runLabel === null ? null : (
              <p>
                <span>{copy.dashboard.thisBattle.run.short}</span>
                <ServerValue value={vm.runLabel} kind="name" />
              </p>
            )}
          </>
        }
        confirmLabel={words.confirm.short}
        cancelLabel={copy.dashboard.shell.cancel.short}
        onConfirm={() => {
          setAsking(false);
          if (takeover.command !== null) void commands.takeOver(takeover.command);
        }}
        onCancel={() => {
          setAsking(false);
        }}
      />
    </RegionBody>
  );
}
