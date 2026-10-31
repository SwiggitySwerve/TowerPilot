import { useId } from 'react';
import { copy } from '../../copy/catalogue.ts';
import type { CopyText } from '../../copy/text.ts';
import { selectRunsPage, type RunChoiceVM } from '../../store/selectors/runs.ts';
import { Button } from '../../ui/Button.tsx';
import { KindTag } from '../../ui/Pill.tsx';
import { RecordRow } from '../../ui/RecordRow.tsx';
import { ServerValue } from '../../ui/ServerValue.tsx';
import { ShownList } from '../../ui/ShownList.tsx';
import { StatusDot, type DotTone } from '../../ui/StatusDot.tsx';
import { useDashboard, useView } from '../dashboard/context.ts';

const t = copy.runs;
const words = copy.dashboard.startNext;

/** The Recognition page prepares runs; the list links there (the old Prepare button). */
const RECOGNITION = '#recognition';

const TONES: Readonly<Record<RunChoiceVM['readiness'], DotTone>> = {
  ready: 'ok',
  needs_setup: 'warn',
  not_ready: 'warn',
  images_missing: 'warn',
  readiness_check_failed: 'bad',
  readiness_unknown: 'unknown',
};

function readinessText(run: RunChoiceVM): CopyText {
  return run.readiness === 'images_missing'
    ? words.imagesMissing(run.imageCount)
    : words.readiness[run.readiness].short;
}

function kindLabel(kind: string | null): CopyText {
  const kinds: Readonly<Record<string, { readonly short: CopyText }>> = t.list.kinds;
  return kind !== null && Object.hasOwn(kinds, kind)
    ? (kinds[kind]?.short ?? t.list.otherKind.short)
    : t.list.otherKind.short;
}

function RunRow({ run, selected }: { readonly run: RunChoiceVM; readonly selected: boolean }) {
  const { commands } = useDashboard();
  const nameId = useId();
  return (
    <RecordRow
      name={
        <span id={nameId}>
          {run.label !== null ? (
            <ServerValue kind="name" value={run.label} />
          ) : run.name !== null ? (
            <ServerValue kind="id" value={run.name} />
          ) : (
            t.saved.unnamedRun.short
          )}
        </span>
      }
      kind={
        <>
          <KindTag label={kindLabel(run.kind)} />
          {selected ? <KindTag label={t.list.editing.short} /> : null}
        </>
      }
      summary={
        <>
          {t.list.equipment.short}
          {t.list.space}
          {run.asIs ? (
            t.list.currentEquipment.short
          ) : run.loadout === null ? (
            t.list.noEquipment.short
          ) : (
            <ServerValue kind="name" value={run.loadout} />
          )}
          {run.tier === null ? null : t.list.tier(run.tier)}
          {run.restartViaHome ? t.list.restartViaHome.short : null}
        </>
      }
      actions={
        <>
          <span className="tp-runs__readiness" data-readiness={run.readiness}>
            <StatusDot tone={TONES[run.readiness]} />
            {readinessText(run)}
          </span>
          {run.readiness === 'ready' ? null : (
            <a className="tp-button" data-tier="quiet" href={RECOGNITION}>
              {t.list.prepare.short}
            </a>
          )}
          {/* The run being edited is already open below; its row says so instead. */}
          {selected ? null : (
            <Button
              tier="quiet"
              label={t.list.edit.short}
              targetId={nameId}
              focusKey={`runs:edit:${run.key}`}
              onClick={() => {
                commands.openRuns(true, run.key);
              }}
            />
          )}
        </>
      }
    />
  );
}

/**
 * Every run of the profile as one record row (name, kind, equipment and tier, readiness,
 * Prepare and Edit), never folded. Edit opens that run in the editors below.
 */
export function RunsList() {
  const { saved } = useView(selectRunsPage);
  if (saved.runs.length === 0) return <p>{t.saved.noRuns.short}</p>;
  return (
    <div className="tp-runs__list" data-runs-list="true">
      <ShownList
        items={saved.runs}
        itemKey={(run) => run.key}
        limit="all"
        className="tp-runs__list-items"
        render={(run) => <RunRow run={run} selected={run.key === saved.run} />}
      />
    </div>
  );
}
