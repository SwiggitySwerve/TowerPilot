import { copy } from '../../../../copy/catalogue.ts';
import type { OperationRowVM } from '../../../../store/selectors/automationSlot.ts';
import { Chip } from '../../../../ui/Chip.tsx';
import { Disclosure } from '../../../../ui/Disclosure.tsx';
import { ServerValue } from '../../../../ui/ServerValue.tsx';
import { AutomationLine, AutomationWhy } from './AutomationLine.tsx';

const text = copy.dashboard.automation;

/** The visible identity and core-owned status of one automation target. */
export function AutomationFacts({ row }: { readonly row: OperationRowVM }) {
  const battle = row.battle;
  return (
    <div data-operation-key={row.key}>
      {/* F4-02: the target's name and its state share one line (spec 2.2 sketch). */}
      <div className="tp-automation-head">
        <p id={`automation-${row.key}`}>
          {row.label === null ? (
            text.purposes[row.purpose].short
          ) : (
            <ServerValue kind="name" value={row.label} />
          )}
        </p>
        <AutomationLine seen={row.seen} />
      </div>
      {battle.line === 'wave' && battle.wave !== null ? (
        <p>{text.wave(battle.wave)}</p>
      ) : battle.line === 'last_wave' && battle.wave !== null ? (
        <p>{text.lastWave(battle.wave, battle.ageSec)}</p>
      ) : battle.line === 'wave' || battle.line === 'last_wave' ? null : (
        <p>{text.battle[battle.line].short}</p>
      )}
      {row.created !== null ? (
        <p id={`automation-identity-${row.key}`}>{text.started(row.created, row.pid)}</p>
      ) : row.pid === null ? null : (
        <p id={`automation-identity-${row.key}`}>{text.startUnknown(row.pid)}</p>
      )}
      {row.seen.params['foreign'] === true ? <p>{text.foreign.short}</p> : null}
      {row.scheduledStop === null ? null : (
        <p>
          {row.scheduledStop ? <Chip state="waiting" /> : null}
          <span>{row.scheduledStop ? text.scheduled.short : text.unscheduled.short}</span>
        </p>
      )}
    </div>
  );
}

/** Server detail stays behind a stable native disclosure through every poll. */
export function AutomationMeta({ row }: { readonly row: OperationRowVM }) {
  return (
    <>
      <AutomationWhy seen={row.seen} />
      <Disclosure label={text.details.short} focusKey={`automation-details:${row.key}`}>
        {row.details.cmdline === null ? (
          <p>{text.detailsUnavailable.short}</p>
        ) : (
          <ServerValue kind="detail" value={row.details.cmdline} />
        )}
        {row.details.instance === null ? null : (
          <p>
            <span>{text.instance.short}</span>
            <ServerValue kind="name" value={row.details.instance} />
          </p>
        )}
        {row.details.step === null ? null : (
          <p>
            <span>{text.step.short}</span>
            <ServerValue kind="detail" value={row.details.step} />
          </p>
        )}
        {row.details.recovery === null ? null : (
          <p>
            <span>{text.boundary.short}</span>
            <ServerValue kind="detail" value={row.details.recovery} />
          </p>
        )}
      </Disclosure>
    </>
  );
}
