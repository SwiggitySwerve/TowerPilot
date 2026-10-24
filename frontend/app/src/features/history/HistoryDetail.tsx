import { history as t } from '../../copy/history.ts';
import type { ServerText } from '../../copy/server.ts';
import type { CopyText, CopyNode } from '../../copy/text.ts';
import type { HistoryDetailVM } from '../../store/selectors/history.ts';
import { Disclosure } from '../../ui/Disclosure.tsx';
import { ActionExecutions } from './ActionExecutions.tsx';
import { ServerValue } from '../../ui/ServerValue.tsx';

export function HistoryText({ value }: { readonly value: ServerText<'detail'> | null }) {
  return value === null ? t.unknown.short : <ServerValue kind="detail" value={value} />;
}
function Fact({ label, children }: { readonly label: CopyText; readonly children: CopyNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
function Evidence({
  value,
  label,
}: {
  readonly value: ServerText<'detail'> | null;
  readonly label: CopyText;
}) {
  if (value === null) return <p>{t.unknown.short}</p>;
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Scrollable evidence needs keyboard focus (WCAG 2.1.1).
    <pre tabIndex={0} role="region" aria-label={label}>
      <ServerValue kind="detail" value={value} />
    </pre>
  );
}

/** Presentation of checked historical evidence. No collection arithmetic or outcome inference. */
export function HistoryDetail({
  vm,
  onOlder,
}: {
  readonly vm: HistoryDetailVM;
  readonly onOlder: () => void;
}) {
  return (
    <div className="tp-history__evidence">
      <h3>{vm.name === null ? t.unnamed.short : <ServerValue kind="name" value={vm.name} />}</h3>
      {vm.status === 'interrupted' ? (
        <p className="tp-history__notice">{t.interrupted.short}</p>
      ) : null}
      {vm.status === 'prepared' ? <p className="tp-history__notice">{t.prepared.short}</p> : null}
      {vm.partial ? <p className="tp-history__notice">{t.partial.short}</p> : null}
      <dl className="tp-history__facts">
        <Fact label={t.id.short}>
          {vm.recordId === null ? t.unknown.short : <ServerValue kind="id" value={vm.recordId} />}
        </Fact>
        <Fact label={t.status.short}>
          <HistoryText value={vm.status} />
        </Fact>
        <Fact label={t.result.short}>
          <HistoryText value={vm.result} />
        </Fact>
        <Fact label={t.reason.short}>
          {vm.reason === null ? t.unknown.short : <ServerValue kind="message" value={vm.reason} />}
        </Fact>
        <Fact label={t.origin.short}>
          <HistoryText value={vm.origin} />
        </Fact>
        <Fact label={t.certainty.short}>
          <HistoryText value={vm.certainty} />
        </Fact>
        <Fact label={t.tier.short}>{t.number(vm.tier)}</Fact>
        <Fact label={t.observedWave.short}>{t.number(vm.observedWave)}</Fact>
        <Fact label={t.finalWave.short}>{t.number(vm.finalWave)}</Fact>
        <Fact label={t.provenance.short}>
          <HistoryText value={vm.provenance} />
        </Fact>
        <Fact label={t.start.short}>{t.time(vm.startedAt)}</Fact>
        <Fact label={t.observedStart.short}>{t.time(vm.observedAt)}</Fact>
        <Fact label={t.ended.short}>{t.time(vm.endedAt)}</Fact>
        <Fact label={t.updated.short}>{t.time(vm.updatedAt)}</Fact>
        <Fact label={t.duration.short}>{t.seconds(vm.duration)}</Fact>
        <Fact label={t.observation.short}>
          <HistoryText value={vm.observation} />
        </Fact>
        <Fact label={t.previousId.short}>
          {vm.previousId === null ? (
            t.unknown.short
          ) : (
            <ServerValue kind="id" value={vm.previousId} />
          )}
        </Fact>
      </dl>
      <section aria-label={t.setup.short}>
        <h3>{t.setup.short}</h3>
        <dl className="tp-history__facts">
          <Fact label={t.setupState.short}>
            <HistoryText value={vm.setup.state} />
          </Fact>
          <Fact label={t.setupDetail.short}>
            <HistoryText value={vm.setup.detail} />
          </Fact>
          <Fact label={t.setupReason.short}>
            {vm.setup.reason === null ? (
              t.unknown.short
            ) : (
              <ServerValue kind="message" value={vm.setup.reason} />
            )}
          </Fact>
          <Fact label={t.loadout.short}>
            {vm.setup.loadout === null ? (
              t.unknown.short
            ) : (
              <ServerValue kind="name" value={vm.setup.loadout} />
            )}
          </Fact>
        </dl>
        {vm.setup.partial ? <p>{t.setupPartial.short}</p> : null}
        <Disclosure label={t.modules.short}>
          <Evidence value={vm.setup.modules} label={t.moduleRecord.short} />
        </Disclosure>
      </section>
      <section aria-label={t.stats.short}>
        <h3>{t.stats.short}</h3>
        <p>{t.statsStates[vm.stats.state].short}</p>
        <dl className="tp-history__facts">
          <Fact label={t.statsRecordedState.short}>
            <HistoryText value={vm.stats.recordedState} />
          </Fact>
          {vm.stats.reason === null ? null : (
            <Fact label={t.statsReason.short}>
              <ServerValue kind="message" value={vm.stats.reason} />
            </Fact>
          )}
          {vm.stats.error === null ? null : (
            <Fact label={t.statsError.short}>
              <ServerValue kind="message" value={vm.stats.error} />
            </Fact>
          )}
        </dl>
        <Disclosure label={t.rawEvidence.short}>
          <Evidence value={vm.stats.raw} label={t.statsRecord.short} />
        </Disclosure>
      </section>
      <section aria-label={t.collection.short}>
        <h3>{t.collection.short}</h3>
        <p>{t.collectionStates[vm.collection.state].short}</p>
        <p className="tp-history__note">{t.sampled.short}</p>
        <dl className="tp-history__facts">
          <Fact label={t.claims.short}>{t.number(vm.collection.claims)}</Fact>
          <Fact label={t.balances.short}>{t.number(vm.collection.balances)}</Fact>
          <Fact label={t.increase.short}>{t.number(vm.collection.increase)}</Fact>
          <Fact label={t.from.short}>{t.time(vm.collection.startedAt)}</Fact>
          <Fact label={t.through.short}>{t.time(vm.collection.throughAt)}</Fact>
        </dl>
        <Disclosure label={t.rawEvidence.short}>
          <Evidence value={vm.collectionRaw} label={t.collectionRecord.short} />
        </Disclosure>
      </section>
      <ActionExecutions vm={vm.executions} onOlder={onOlder} />
      <section aria-label={t.gaps.short}>
        <h3>{t.gaps.short}</h3>
        <p className="tp-history__note">{t.gapNote.short}</p>
        <dl className="tp-history__facts">
          <Fact label={t.openGap.short}>{t.time(vm.openGap)}</Fact>
        </dl>
        <Evidence value={vm.gaps} label={t.gapRecord.short} />
      </section>
      <Disclosure label={t.boundary.short}>
        <Evidence value={vm.boundary} label={t.boundary.short} />
      </Disclosure>
      <Disclosure label={t.snapshot.short}>
        {vm.snapshot === null ? (
          <p>{t.noSnapshot.short}</p>
        ) : (
          <Evidence value={vm.snapshot} label={t.snapshot.short} />
        )}
        <h3>{t.effective.short}</h3>
        <Evidence value={vm.effective} label={t.effective.short} />
      </Disclosure>
      <Disclosure label={t.activity.short}>
        {vm.events.length === 0 ? (
          <p>{t.noActivity.short}</p>
        ) : (
          <ol className="tp-history__activity">
            {vm.events.map((event, index) => (
              <li key={event.key}>
                <time>{t.time(event.at)}</time>
                <HistoryText value={event.kind} />
                <Evidence value={event.raw} label={t.eventRecord(index + 1)} />
              </li>
            ))}
          </ol>
        )}
      </Disclosure>
    </div>
  );
}
