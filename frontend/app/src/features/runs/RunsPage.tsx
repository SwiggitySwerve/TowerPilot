import { useEffect, useId, useState } from 'react';
import { pageHref, type PageTarget, type SavedSection } from '../../ui/routes.ts';
import { copy } from '../../copy/catalogue.ts';
import type { CopyNode } from '../../copy/text.ts';
import { selectRunsPage } from '../../store/selectors/runs.ts';
import { editingTargetVM, selectEditingTarget } from '../../store/selectors/editingTarget.ts';
import { Button } from '../../ui/Button.tsx';
import { ActionRow } from '../../ui/ActionRow.tsx';
import { Tile } from '../../ui/Tile.tsx';
import { RegionBoundary } from '../../ui/RegionBoundary.tsx';
import { Region, RegionBody, RegionEnd, RegionInline } from '../../ui/Region.tsx';
import { ServerValue } from '../../ui/ServerValue.tsx';
import { Why } from '../../ui/Why.tsx';
import { SectionPanel, SectionTabs } from '../../ui/SectionTabs.tsx';
import {
  FaultPoint,
  useDashboard,
  useEpochKey,
  usePartError,
  useView,
} from '../dashboard/context.ts';
import { RevocationFallback } from '../dashboard/shared/RevocationFallback.tsx';
import { TopBar } from '../dashboard/topBar/TopBar.tsx';
import { BattleDetails } from './BattleDetails.tsx';
import { RunEditor } from './RunEditor.tsx';
import { LiveShopping } from './LiveShopping.tsx';
import { RunEntry } from './RunEntry.tsx';
import { RunsList } from './RunsList.tsx';
import { SavedShopping } from './SavedShopping.tsx';
import { AddRun } from './AddRun.tsx';
import { ShoppingLibrary } from './ShoppingLibrary.tsx';
import { RunOutcome } from './RunOutcome.tsx';
import { RunDefaults } from './RunDefaults.tsx';
import './runs.css';

const t = copy.runs;

/** The page's sections, one shown at a time: this battle, saved settings, shared policies. */
type PageSection = 'live' | 'saved' | 'library';

const PAGE_SECTIONS = [
  { key: 'live', label: t.live.title.short },
  { key: 'saved', label: t.saved.title.short },
  { key: 'library', label: copy.shoppingLibrary.title.short },
] as const;

/** The edited run's settings, one section at a time. */
const SAVED_TABS = [
  { key: 'routines', label: t.saved.routinesTab.short },
  { key: 'queue', label: copy.shoppingSaved.title.short },
  { key: 'entry', label: copy.runEntry.title.short },
] as const;

/** PE6: these forms keep their active values; the entry editor has its own target. */
function ActiveOnly({ children }: { readonly children: CopyNode }) {
  const target = useView(selectEditingTarget);
  const vm = editingTargetVM(target);
  const reasonId = useId();
  return (
    <fieldset
      className="tp-run-entry tp-run-entry__field"
      disabled={target.inactive}
      data-runs-active-only="true"
      aria-describedby={target.inactive ? reasonId : undefined}
    >
      {target.inactive ? (
        <>
          <legend className="tp-profiles__summary">
            <span>{copy.editingTarget.active.short}</span>
            {vm.active === null ? (
              copy.editingTarget.none.short
            ) : (
              <ServerValue kind="name" value={vm.active} />
            )}
          </legend>
          <div id={reasonId}>{copy.runEntry.activeOnly.short}</div>
        </>
      ) : null}
      <div>{children}</div>
    </fieldset>
  );
}

function LiveSection() {
  const vm = useView(selectRunsPage);
  const { commands } = useDashboard();
  const live = vm.live;
  const line = live.outcome;
  if (live.state !== 'tracked' || live.editor === null || !live.active) {
    const entry =
      live.state === 'tracked'
        ? t.live.prepared
        : live.state === 'none'
          ? t.live.none
          : t.live.unavailable;
    const check = (
      <Button
        tier="quiet"
        label={t.live.check.short}
        focusKey="runs:check-battle"
        onClick={commands.checkBattle}
      />
    );
    // F6R-04: the lines of a battle no longer shown stay, each naming its battle.
    return line === null && live.earlier.length === 0 && live.details.length === 0 ? (
      <RegionInline>
        <span>{entry.short}</span>
        {check}
      </RegionInline>
    ) : (
      <RegionBody>
        <ActionRow>
          <span>{entry.short}</span>
          {check}
        </ActionRow>
        {live.earlier.map((earlier) => (
          <RunOutcome key={earlier.line.id} outcome={earlier} />
        ))}
        {line === null ? null : <RunOutcome outcome={line} />}
        <BattleDetails details={live.details} lastKnown={live.detailsLastKnown} />
      </RegionBody>
    );
  }
  return (
    <>
      <RegionEnd>
        <span className="tp-runs__battle">
          {live.label === null ? null : <ServerValue kind="name" value={live.label} />}
          {live.wave === null ? null : <span>{copy.dashboard.thisBattle.wave(live.wave)}</span>}
        </span>
      </RegionEnd>
      <RegionBody>
        <Tile titleId="runs-live-routines" title={t.live.routines.short} intro={t.live.scope}>
          {live.boundsKnown ? null : (
            <div className="tp-runs__note">
              <span>{t.live.boundsUnknown.short}</span>
              <Why why={t.live.boundsUnknown.why} />
            </div>
          )}
          <RunEditor
            editor={live.editor}
            live
            saveLabel={t.live.save}
            onSave={(command) => {
              void commands.saveLive(command);
            }}
            extra={
              <Button
                tier="quiet"
                label={t.live.check.short}
                focusKey="runs:check-battle"
                onClick={commands.checkBattle}
              />
            }
          />
        </Tile>
        <LiveShopping />
        {line === null ? null : <RunOutcome outcome={line} />}
        {live.earlier.map((earlier) => (
          <RunOutcome key={earlier.line.id} outcome={earlier} />
        ))}
        <BattleDetails details={live.details} lastKnown={live.detailsLastKnown} />
      </RegionBody>
    </>
  );
}

function SavedSection({
  section,
  onSection,
}: {
  readonly section: SavedSection;
  readonly onSection: (section: SavedSection) => void;
}) {
  const vm = useView(selectRunsPage);
  const { commands } = useDashboard();
  const saved = vm.saved;
  const line = saved.outcome;
  return (
    <>
      <RegionEnd>
        {saved.readAgeSec === null ? null : <span>{t.readAge(saved.readAgeSec)}</span>}
        {/* Reading the run again serves every section of its settings, so it sits beside its age. */}
        {saved.editor === null ? null : (
          <Button
            tier="quiet"
            label={t.saved.check.short}
            focusKey="runs:check"
            onClick={commands.checkRun}
          />
        )}
      </RegionEnd>
      <RegionBody>
        <Tile titleId="runs-saved-routines" title={t.saved.routines.short} intro={t.saved.scope}>
          <RunsList />
          <ActiveOnly>
            {/* With no runs yet, adding one is the only thing to do here. */}
            <AddRun openFirst={saved.scopeReady && saved.runs.length === 0} />
          </ActiveOnly>
          {saved.run !== null && !saved.runListed ? (
            <p className="tp-runs__note" data-run-unlisted="true">
              {t.saved.notListed.short}
            </p>
          ) : null}
          {saved.comboListed ? <p className="tp-runs__note">{t.saved.combo.short}</p> : null}
          {saved.notice === null ? null : (
            <p className="tp-runs__note">
              <ServerValue kind="message" value={saved.notice} />
            </p>
          )}
          {saved.catalogueUnavailable ? (
            <div className="tp-runs__note" role="status">
              <p>{t.saved.catalogueUnavailable.short}</p>
              {saved.catalogueError === null ? null : (
                <ServerValue kind="message" value={saved.catalogueError} />
              )}
              <Button tier="quiet" label={t.saved.checkRuns.short} onClick={commands.checkRuns} />
            </div>
          ) : saved.read === 'not_read' && saved.runs.length > 0 ? (
            <p>{t.saved.reading.short}</p>
          ) : null}
          {saved.read === 'unavailable' ? (
            <p className="tp-runs__note">
              <span>{t.saved.unavailable.short}</span>
              {saved.readError !== null ? (
                <ServerValue kind="message" value={saved.readError} />
              ) : saved.readFailure === null ? null : (
                <span>{t.saved.failures[saved.readFailure].short}</span>
              )}
              {/* SR-8: reading the run again stays possible while its read fails. */}
              <Button
                tier="quiet"
                label={t.saved.check.short}
                focusKey="runs:check"
                onClick={commands.checkRun}
              />
            </p>
          ) : null}
        </Tile>
        {/* The edited run's settings, one section at a time; its outcome and the defaults stay in view. */}
        <SectionTabs
          label={t.saved.sections.short}
          idPrefix="runs-run"
          sections={SAVED_TABS}
          current={section}
          onSelect={onSection}
        />
        <SectionPanel idPrefix="runs-run" section="routines" current={section}>
          <ActiveOnly>
            {saved.editor === null ? null : (
              <Tile titleId="runs-saved-editor" title={t.saved.editor.short}>
                <RunEditor
                  editor={saved.editor}
                  live={false}
                  saveLabel={t.saved.save}
                  onSave={(command) => {
                    void commands.saveRun(command);
                  }}
                />
              </Tile>
            )}
          </ActiveOnly>
        </SectionPanel>
        <SectionPanel idPrefix="runs-run" section="queue" current={section}>
          <ActiveOnly>
            <SavedShopping />
          </ActiveOnly>
        </SectionPanel>
        <SectionPanel idPrefix="runs-run" section="entry" current={section}>
          <RunEntry />
        </SectionPanel>
        {line === null ? null : <RunOutcome outcome={line} />}
        <RunDefaults />
      </RegionBody>
    </>
  );
}

function RunsRegion({
  id,
  part,
  title,
  children,
}: {
  readonly id: string;
  readonly part: 'runsLive' | 'runsSaved';
  readonly title: typeof t.live.title;
  readonly children: CopyNode;
}) {
  return (
    <Region
      id={id}
      title={title.short}
      fallback={<RevocationFallback part={part} />}
      resetKey={useEpochKey()}
      onError={usePartError(part)}
    >
      <FaultPoint part={part} />
      {children}
    </Region>
  );
}

/** Which sections a route opens; a route that names none keeps what is shown. */
function sectionsOf(target: PageTarget | null): {
  readonly page: PageSection | null;
  readonly saved: SavedSection | null;
} {
  if (target?.kind === 'live') return { page: 'live', saved: null };
  if (target?.kind === 'library') return { page: 'library', saved: null };
  if (target?.kind === 'saved') return { page: 'saved', saved: target.section ?? null };
  return { page: null, saved: null };
}

/**
 * The Runs page (brief RUN-01 to RUN-13): this battle's live settings, the saved
 * settings of a run, and the shared shopping policies, one section at a time.
 * Each is its own region with its own boundary (a fallback keeps Pause
 * harvesting and Turn input off), and every section stays mounted while
 * hidden. Opening it tells the store which run to read; a route target shows
 * its section and focuses its heading.
 */
export function RunsPage({
  target,
}: {
  /** The route's target (app/router.ts `#runs/live`, `#runs/saved/<run>`); others open nothing. */
  readonly target: PageTarget | null;
}) {
  const { commands } = useDashboard();
  const run = target?.kind === 'saved' ? target.run : null;
  const focus =
    target?.kind === 'live' || target?.kind === 'saved' || target?.kind === 'library'
      ? target.kind
      : null;
  const route = target === null ? '' : pageHref('runs', target);
  const [shown, setShown] = useState(() => {
    const opened = sectionsOf(target);
    return { route, page: opened.page ?? 'saved', saved: opened.saved ?? 'routines' };
  });
  let current = shown;
  if (shown.route !== route) {
    // A new route shows its section before anything paints, so its heading can take focus.
    const opened = sectionsOf(target);
    current = { route, page: opened.page ?? shown.page, saved: opened.saved ?? shown.saved };
    setShown(current);
  }
  // A link to the address already open fires no hashchange: it shows the sections it names again.
  const [reopened, setReopened] = useState(0);
  useEffect(() => {
    const reopen = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (link === null || route === '' || link.getAttribute('href') !== window.location.hash)
        return;
      const opened = sectionsOf(target);
      setShown((now) => ({
        route: now.route,
        page: opened.page ?? now.page,
        saved: opened.saved ?? now.saved,
      }));
      setReopened((count) => count + 1);
    };
    document.addEventListener('click', reopen);
    return () => {
      document.removeEventListener('click', reopen);
    };
  }, [route, target]);
  useEffect(() => {
    commands.openRuns(true, run);
  }, [commands, run]);
  useEffect(
    () => () => {
      commands.openRuns(false, null);
    },
    [commands],
  );
  useEffect(() => {
    if (focus === null) return;
    const heading = { live: 'runsLive', saved: 'runsSaved', library: 'shoppingLibrary' }[focus];
    document.getElementById(`${heading}-title`)?.focus();
  }, [focus, run, route, reopened]);
  return (
    <>
      <header className="tp-topbar">
        <RegionBoundary
          fallback={<RevocationFallback part="topBar" />}
          resetKey={useEpochKey()}
          onError={usePartError('topBar')}
        >
          <FaultPoint part="topBar" />
          <TopBar pageId="runs" title={t.pageName.short} />
        </RegionBoundary>
      </header>
      <main id="main" className="tp-main" tabIndex={-1}>
        <FaultPoint part="page" />
        <div className="tp-runs">
          <SectionTabs
            label={t.sections.short}
            idPrefix="runs-page"
            sections={PAGE_SECTIONS}
            current={current.page}
            onSelect={(page) => {
              setShown({ ...current, page });
            }}
          />
          <SectionPanel idPrefix="runs-page" section="live" current={current.page}>
            <RunsRegion id="runsLive" part="runsLive" title={t.live.title}>
              <ActiveOnly>
                <LiveSection />
              </ActiveOnly>
            </RunsRegion>
          </SectionPanel>
          <SectionPanel idPrefix="runs-page" section="saved" current={current.page}>
            <RunsRegion id="runsSaved" part="runsSaved" title={t.saved.title}>
              <SavedSection
                section={current.saved}
                onSection={(saved) => {
                  setShown({ ...current, saved });
                }}
              />
            </RunsRegion>
          </SectionPanel>
          <SectionPanel idPrefix="runs-page" section="library" current={current.page}>
            <ActiveOnly>
              <ShoppingLibrary />
            </ActiveOnly>
          </SectionPanel>
        </div>
      </main>
    </>
  );
}
