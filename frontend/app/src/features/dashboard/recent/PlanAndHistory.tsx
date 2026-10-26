import { copy } from '../../../copy/catalogue.ts';
import { ageAgo, lastRead } from '../../../copy/dashboard/shell.ts';
import type { CopyEntry } from '../../../copy/text.ts';
import { selectRecent, type ScheduleVM } from '../../../store/selectors/recent.ts';
import { Chip } from '../../../ui/Chip.tsx';
import { Disclosure } from '../../../ui/Disclosure.tsx';
import { RegionBody } from '../../../ui/Region.tsx';
import { ServerValue } from '../../../ui/ServerValue.tsx';
import { useView } from '../context.ts';
import { DashboardRegion } from '../shared/DashboardRegion.tsx';
import './recent.css';

const words = copy.dashboard.recent;
const scheduleLines: Readonly<Record<string, CopyEntry>> = words.lines;

/** Read-only schedule wording; eligibility and state belong to core/schedule. */
function ScheduleLine({ vm }: { readonly vm: ScheduleVM }) {
  if (vm.line === 'last_known' && vm.previous !== null) {
    const age = vm.params['ageSec'];
    return (
      <>
        <span>{words.lastKnown.short}</span>
        <ScheduleLine vm={vm.previous} />
        {typeof age === 'number' ? <span>{lastRead(age)}</span> : null}
      </>
    );
  }
  if (vm.line === 'winner_next_check' || vm.line === 'winner_no_clock_check') {
    return (
      <>
        {vm.winner === null ? (
          words.winnerUnknown.short
        ) : (
          <ServerValue value={vm.winner} kind="name" />
        )}
        {words.separator.short}
        <span>
          {vm.nextClockAt === null
            ? words.noClock.short
            : words.nextCheck(vm.nextClockAt, vm.clockOffsetSec)}
        </span>
        {vm.nextInSec === null ? null : <span>{words.inDuration(vm.nextInSec)}</span>}
        {words.separator.short}
        <span>{words.switchAtEnd.short}</span>
      </>
    );
  }
  if (vm.line === 'last_seen') {
    const age = vm.params['ageSec'];
    return (
      <>
        {words.lastSeen.short}
        {vm.observedWinner === null ? (
          words.winnerUnknown.short
        ) : (
          <ServerValue value={vm.observedWinner} kind="name" />
        )}
        <span>{typeof age === 'number' ? ageAgo(age) : words.noAge.short}</span>
      </>
    );
  }
  return scheduleLines[vm.line]?.short ?? words.lines.schedule_unknown.short;
}

/** Subscribed inside the region boundary, so selector faults retain its fallback. */
function RecentContent() {
  const vm = useView(selectRecent);
  const last = vm.lastBattle;
  const battle = last.battle.kind === 'known' ? last.battle.value : null;
  return (
    <RegionBody>
      <ul className="tp-rows tp-recent">
        <li className="tp-recent-row">
          <span className="tp-recent-label">{words.schedule.short}</span>
          <div className="tp-recent-facts">
            {vm.schedule.word === null ? null : <Chip state={vm.schedule.word} />}
            <span className="tp-recent-line">
              <ScheduleLine vm={vm.schedule} />
            </span>
            {vm.schedule.word === null ? null : (
              <Disclosure label={copy.common.why.short} focusKey="schedule-why">
                {vm.schedule.reason === null ? null : (
                  <ServerValue
                    value={vm.schedule.reason}
                    kind="detail"
                    label={words.reason.short}
                  />
                )}
                {vm.schedule.error === null ? null : (
                  <ServerValue value={vm.schedule.error} kind="message" />
                )}
                {vm.schedule.previous?.error === null ||
                vm.schedule.previous?.error === undefined ? null : (
                  <ServerValue value={vm.schedule.previous.error} kind="message" />
                )}
              </Disclosure>
            )}
          </div>
          <a href="#schedule">{words.scheduleLink.short}</a>
        </li>
        <li className="tp-recent-row">
          <span className="tp-recent-label">{words.lastBattle.short}</span>
          <div className="tp-recent-facts">
            {battle === null ? (
              <span>
                {last.line === 'recorded' || last.line === 'last_known'
                  ? words.battleLines.unavailable.short
                  : words.battleLines[last.line].short}
              </span>
            ) : (
              <>
                <span className="tp-recent-line">
                  {last.line === 'last_known' ? <span>{words.lastKnown.short}</span> : null}
                  {battle.label === null ? (
                    words.battleUnknown.short
                  ) : (
                    <ServerValue value={battle.label} kind="name" />
                  )}
                  {words.separator.short}
                  <span>{words.ends[battle.line].short}</span>
                  <span>
                    {last.endedAgeSec === null ? words.noAge.short : ageAgo(last.endedAgeSec)}
                  </span>
                  {words.separator.short}
                  <span>{battle.wave === null ? words.noWave.short : words.wave(battle.wave)}</span>
                </span>
                <Disclosure label={copy.common.why.short} focusKey="last-battle-why">
                  <p>
                    {battle.endedAt === null
                      ? words.noTime.short
                      : words.recordedAt(battle.endedAt)}
                  </p>
                  {last.readAgeSec === null ? null : <p>{lastRead(last.readAgeSec)}</p>}
                  {battle.line !== 'tracking_ended' || battle.status === null ? null : (
                    <ServerValue value={battle.status} kind="detail" label={words.status.short} />
                  )}
                  {battle.blueprint === null ? null : (
                    <ServerValue value={battle.blueprint} kind="id" label={words.blueprint.short} />
                  )}
                  {battle.endReason === null ? null : (
                    <ServerValue
                      value={battle.endReason}
                      kind="message"
                      label={words.endReason.short}
                    />
                  )}
                  {battle.result === null ? null : (
                    <ServerValue value={battle.result} kind="detail" label={words.result.short} />
                  )}
                </Disclosure>
              </>
            )}
          </div>
          <a href="#history">{words.historyLink.short}</a>
        </li>
      </ul>
    </RegionBody>
  );
}

/** Region 5: one Schedule line and one Last battle line (F-077 to F-080). */
export function PlanAndHistory() {
  return (
    <DashboardRegion id="recent">
      <RecentContent />
    </DashboardRegion>
  );
}
