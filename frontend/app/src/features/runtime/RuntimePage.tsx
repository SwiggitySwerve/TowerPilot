import { useEffect, useState } from 'react';
import type { RuntimeStore } from '../../store/runtime.ts';
import { runtime as t } from '../../copy/runtime.ts';
import { RawData } from './RawData.tsx';
import { selectRuntimeSettings } from '../../store/selectors/runtime.ts';
import { useDashboard, useEpochKey, usePartError, useView } from '../dashboard/context.ts';
import { TopBar } from '../dashboard/topBar/TopBar.tsx';
import { ScopedSettingsModule } from '../settings/ScopedSettingsModule.tsx';
import { runtimeConfig as c } from '../../copy/runtimeConfig.ts';
import { HelpTip } from '../../ui/HelpTip.tsx';
import { Region, RegionBody } from '../../ui/Region.tsx';
import { ServerValue } from '../../ui/ServerValue.tsx';
import { Button } from '../../ui/Button.tsx';
import { ActionRow } from '../../ui/ActionRow.tsx';
import { Tile } from '../../ui/Tile.tsx';
import { CopyLine } from '../../ui/CopyLine.tsx';
import { Fact, Facts } from '../../ui/Facts.tsx';
import { SectionPanel, SectionTabs } from '../../ui/SectionTabs.tsx';
import { IdentitySection } from './IdentitySection.tsx';
import { DiagnosticsSection } from './DiagnosticsSection.tsx';
import './runtime.css';

type Group = 'defaults' | 'overrides' | 'machine';

const GROUPS: readonly Group[] = ['defaults', 'overrides', 'machine'];

const GROUP_TABS = GROUPS.map((group) => ({ key: group, label: t.groupTabs[group].short }));

/** The page's sections, one shown at a time. */
type PageSection = 'runtimeSettings' | 'runtimeIdentity' | 'runtimeDiagnostics';

const PAGE_SECTIONS: readonly {
  readonly key: PageSection;
  readonly label: typeof t.settings.short;
}[] = [
  { key: 'runtimeSettings', label: t.settings.short },
  { key: 'runtimeIdentity', label: t.identity.short },
  { key: 'runtimeDiagnostics', label: t.diagnostics.short },
];

/** The address carries a diagnostic query (the page's own state after `?`). */
function queried(): boolean {
  return /^#\/?runtime\?/u.test(window.location.hash);
}

function SettingsSection() {
  const vm = useView(selectRuntimeSettings);
  const { commands } = useDashboard();
  const [shownGroup, setGroup] = useState<Group>('defaults');
  return (
    <RegionBody>
      <Tile
        titleId="runtime-settings-review"
        title={t.settingsReview.short}
        end={
          <HelpTip label={t.settingsReview.short}>
            <p>{t.settingsSafety.short}</p>
          </HelpTip>
        }
      >
        <Facts layout="cells">
          <Fact
            label={t.targetFields.emulator.short}
            value={
              vm.emulator === null ? (
                t.notReported.short
              ) : (
                <ServerValue kind="name" value={vm.emulator} />
              )
            }
          />
          <Fact
            label={t.targetFields.instance.short}
            value={
              vm.instance === null ? (
                t.notReported.short
              ) : (
                <ServerValue kind="id" value={vm.instance} />
              )
            }
          />
          <Fact
            label={t.targetFields.account.short}
            value={
              vm.account === null ? (
                t.notReported.short
              ) : (
                <ServerValue kind="name" value={vm.account} />
              )
            }
          />
          <Fact
            label={t.targetFields.profile.short}
            value={
              vm.profile === null ? (
                t.notReported.short
              ) : (
                <ServerValue kind="name" value={vm.profile} />
              )
            }
          />
        </Facts>
        {vm.readFailure === null ? null : (
          <div className="tp-runtime__notice" data-settings-read="stale">
            <p>
              {vm.loadedAt === null
                ? t.settingsStates.unavailable.short
                : t.settingsStates.stale.short}
            </p>
            <p>
              {vm.readFailure.network
                ? t.network.short
                : t.settingsFailureStatus(vm.readFailure.status)}
            </p>
            {vm.readFailure.error === null ? null : (
              <p>
                <ServerValue kind="message" value={vm.readFailure.error} />
              </p>
            )}
          </div>
        )}
        {vm.loadedAt === null ? null : (
          <p className="tp-runtime__muted">
            <time>{t.loaded(vm.loadedAt)}</time>
          </p>
        )}
        <details>
          <summary>{t.target.short}</summary>
          <RawData label={t.target.short} value={vm.target} />
        </details>
        <ActionRow>
          <Button tier="quiet" label={t.checkSettings.short} onClick={commands.checkSettings} />
        </ActionRow>
      </Tile>
      {/* One group of saved settings at a time; a group holding an invalid value says so. */}
      <SectionTabs
        label={t.groups.short}
        idPrefix="runtime-group"
        sections={GROUP_TABS}
        current={shownGroup}
        onSelect={setGroup}
      />
      {GROUPS.map((group) => (
        <SectionPanel key={group} idPrefix="runtime-group" section={group} current={shownGroup}>
          <section data-runtime-group={group}>
            <Tile
              titleId={`runtime-group-${group}`}
              title={
                group === 'overrides' ? (
                  <>
                    {c.overrides.short}
                    {vm.emulator === null ? (
                      t.notReported.short
                    ) : (
                      <ServerValue kind="name" value={vm.emulator} />
                    )}
                    {c.openId.short}
                    {vm.instance === null ? (
                      t.notReported.short
                    ) : (
                      <ServerValue kind="id" value={vm.instance} />
                    )}
                    {c.closeId.short}
                  </>
                ) : (
                  c[group].short
                )
              }
            >
              <CopyLine entry={c.groupNotices[group]} variant="intro" />
              <div className="tp-runtime__settings">
                {vm.modules
                  .filter((module) =>
                    group === 'defaults'
                      ? module.id.endsWith('-defaults')
                      : group === 'machine'
                        ? module.id === 'tap' || module.id === 'logging'
                        : module.scope === 'instance' ||
                          ['loop', 'missions', 'fleet'].includes(module.id),
                  )
                  .map((module) => (
                    <div key={module.id} data-runtime-module={module.id}>
                      {module.scope === null ? (
                        <p className="tp-runtime__scope">{t.unknownScope.short}</p>
                      ) : null}
                      {module.status === 'ready' || module.status === 'stale' ? null : (
                        <p data-settings-state={module.status}>
                          {t.settingsStates[module.status].short}
                        </p>
                      )}
                      {module.vm === null ? (
                        <h4>{c.modules[module.id].short}</h4>
                      ) : (
                        <ScopedSettingsModule
                          vm={module.vm}
                          legend={c.modules[module.id]}
                          description={null}
                          applyNotice={null}
                        />
                      )}
                    </div>
                  ))}
              </div>
            </Tile>
          </section>
        </SectionPanel>
      ))}
    </RegionBody>
  );
}

export function RuntimePage({ runtime }: { readonly runtime: RuntimeStore }) {
  const { commands } = useDashboard();
  const epoch = useEpochKey();
  const settingsError = usePartError('runtimeSettings');
  const identityError = usePartError('runtimeIdentity');
  const eventsError = usePartError('runtimeDiagnostics');
  // A diagnostic query in the address (`#runtime?operation_id=...`) opens the events it asks for.
  const [section, setSection] = useState<PageSection>(() =>
    queried() ? 'runtimeDiagnostics' : 'runtimeSettings',
  );
  useEffect(() => {
    const follow = () => {
      if (queried()) setSection('runtimeDiagnostics');
    };
    window.addEventListener('hashchange', follow);
    return () => {
      window.removeEventListener('hashchange', follow);
    };
  }, []);
  useEffect(() => {
    commands.openRuntime(true);
    return () => {
      commands.openRuntime(false);
    };
  }, [commands]);
  return (
    <>
      <header className="tp-topbar">
        <TopBar pageId="runtime" title={t.pageName.short} readOnly />
      </header>
      <main id="main" className="tp-main tp-runtime" tabIndex={-1}>
        <SectionTabs
          label={t.sections.short}
          idPrefix="runtime-page"
          sections={PAGE_SECTIONS}
          current={section}
          onSelect={setSection}
        />
        <SectionPanel idPrefix="runtime-page" section="runtimeSettings" current={section}>
          <Region
            id="runtimeSettings"
            title={t.settings.short}
            fallback={t.fallback.short}
            resetKey={epoch}
            onError={settingsError}
          >
            <SettingsSection />
          </Region>
        </SectionPanel>
        <SectionPanel idPrefix="runtime-page" section="runtimeIdentity" current={section}>
          <Region
            id="runtimeIdentity"
            title={t.identity.short}
            fallback={t.fallback.short}
            resetKey={epoch}
            onError={identityError}
          >
            <IdentitySection runtime={runtime} />
          </Region>
        </SectionPanel>
        <SectionPanel idPrefix="runtime-page" section="runtimeDiagnostics" current={section}>
          <Region
            id="runtimeDiagnostics"
            title={t.diagnostics.short}
            fallback={t.fallback.short}
            resetKey={epoch}
            onError={eventsError}
          >
            <DiagnosticsSection runtime={runtime} />
          </Region>
        </SectionPanel>
      </main>
    </>
  );
}
