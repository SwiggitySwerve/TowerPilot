import { copy } from '../../copy/catalogue.ts';
import type { CopyEntry, CopyNode } from '../../copy/text.ts';
import { actionName } from '../../core/actions.ts';
import type { AdDetailsVM, RoutineDetailsVM, TimeVM } from '../../store/selectors/runs.ts';
import { Disclosure } from '../../ui/Disclosure.tsx';
import { ServerValue } from '../../ui/ServerValue.tsx';
import { Why } from '../../ui/Why.tsx';

const d = copy.runs.live.details;

function since(time: TimeVM): number | null {
  return time.sinceSec;
}

function Row({ label, children }: { readonly label: CopyEntry; readonly children: CopyNode }) {
  return (
    <div className="tp-run-details__row">
      <dt>
        <span>{label.short}</span>
        {label.why === undefined ? null : <Why why={label.why} />}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A reported reason (as sent) with its time, or "None recorded". */
function Recorded({
  value,
}: {
  readonly value: {
    readonly reason: AdDetailsVM['visibilityReason'];
    readonly at: TimeVM | null;
  } | null;
}) {
  if (value === null) return <span>{d.noneRecorded.short}</span>;
  return (
    <span className="tp-run-details__pair">
      {value.reason === null ? null : <ServerValue kind="id" value={value.reason} />}
      <span>{value.at === null ? d.notReported.short : d.at(value.at.at, since(value.at))}</span>
    </span>
  );
}

function collectionText(ad: AdDetailsVM) {
  const c = ad.collection;
  if (c.kind === 'off') return d.collectionOff.short;
  if (c.kind === 'window')
    return c.responseDue === null
      ? d.windowCloses(since(c.windowEnds))
      : d.responseWindow(since(c.responseDue), since(c.windowEnds));
  return c.nextDue === null ? d.nextWindowUnknown.short : d.nextWindow(since(c.nextDue));
}

function AdRows({ ad }: { readonly ad: AdDetailsVM }) {
  return (
    <>
      <Row label={d.offer}>
        <span className="tp-run-details__pair">
          <span>{d.visibility[ad.visibility].short}</span>
          {ad.observationStale ? <span>{d.oldObservation.short}</span> : null}
          {!ad.observationStale && ad.visibilityReason !== null ? (
            <ServerValue kind="id" value={ad.visibilityReason} />
          ) : null}
        </span>
      </Row>
      <Row label={d.firstSeen}>
        <span>
          {ad.firstSeen === null ? d.notSeen.short : d.at(ad.firstSeen.at, since(ad.firstSeen))}
        </span>
      </Row>
      <Row label={d.appeared}>
        <span>
          {ad.appearance === null
            ? d.appearedUnknown.short
            : d.appearedBetween(
                ad.appearance.after.at,
                since(ad.appearance.after),
                ad.appearance.by.at,
                since(ad.appearance.by),
                ad.appearance.gapSec,
              )}
        </span>
      </Row>
      <Row label={d.lastLook}>
        <span>
          {ad.lastObserved === null
            ? d.noLook.short
            : d.at(ad.lastObserved.at, since(ad.lastObserved))}
        </span>
      </Row>
      <Row label={d.collection}>
        <span>{collectionText(ad)}</span>
      </Row>
      <Row label={d.nextLook}>
        <span>{ad.nextCheck === null ? d.notReported.short : d.due(since(ad.nextCheck))}</span>
      </Row>
      <Row label={d.failedAttempt}>
        <Recorded value={ad.failedAttempt} />
      </Row>
      <Row label={d.counts}>
        <span>
          {d.countsLine(
            ad.counters.attempts,
            ad.counters.confirmed,
            ad.counters.skips,
            ad.counters.windowsMissed,
          )}
        </span>
      </Row>
      <Row label={d.timing}>
        <span>
          {d.timingLine(
            ad.durations.schedulingWaitSec,
            ad.durations.responseDelaySec,
            ad.durations.verificationSec,
          )}
        </span>
      </Row>
    </>
  );
}

function RoutineDetails({ details }: { readonly details: RoutineDetailsVM }) {
  const name = actionName(copy.actions.names, details.routine, copy.actions.otherName);
  // A code the page has no name for is shown as sent beside Other routine.
  const known = name !== copy.actions.otherName;
  return (
    <Disclosure label={d.title(name.short)} focusKey={`runs:details:${details.routine}`}>
      <div className="tp-run-details" data-routine-details={details.routine}>
        {known || details.code === null ? null : <ServerValue kind="id" value={details.code} />}
        <dl className="tp-run-details__list">
          {details.ad === null ? null : <AdRows ad={details.ad} />}
          {details.refusal === undefined ? null : (
            <Row label={d.refusal}>
              <Recorded value={details.refusal} />
            </Row>
          )}
        </dl>
        <a className="tp-run-details__inspect" href={details.inspectHash}>
          {d.inspect.short}
        </a>
        {details.raw === null ? null : (
          <Disclosure label={d.raw.short} focusKey={`runs:details-raw:${details.routine}`}>
            <ServerValue kind="detail" value={details.raw} />
          </Disclosure>
        )}
      </div>
    </Disclosure>
  );
}

/** F6-11 RL7: each routine's own report for this battle, read-only (spec F-062, F-063). */
export function BattleDetails({
  details,
  lastKnown,
}: {
  readonly details: readonly RoutineDetailsVM[];
  readonly lastKnown: boolean;
}) {
  if (details.length === 0) return null;
  return (
    <div className="tp-run-details-all" data-part="runsDetails">
      {lastKnown ? (
        <div className="tp-runs__note">
          <span>{d.lastKnown.short}</span>
          <Why why={d.lastKnown.why} />
        </div>
      ) : null}
      {details.map((item) => (
        <RoutineDetails key={item.routine} details={item} />
      ))}
    </div>
  );
}
