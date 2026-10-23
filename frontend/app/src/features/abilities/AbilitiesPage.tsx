import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { list, own, ownPath, text } from '../../core/read.ts';
import { abilities as t, abilityLabel } from '../../copy/abilities.ts';
import {
  abilityKey,
  abilityConsumers,
  abilityReadOnly,
  canSaveAbility,
  canReconcileAbility,
  currentAbilities,
  currentAbility,
  sourceRevision,
  type AbilitiesStore,
  type AbilityFamily,
} from '../../store/abilities.ts';
import { abilityNode, abilityValue, nodeAt, vocabValues } from '../../store/abilitiesDraft.ts';
import {
  abilityGlobalField,
  abilityMessage,
  abilityName,
  latestAbility,
  abilityProblems,
  abilityFieldId,
  abilityErrorAttributes,
} from '../../store/selectors/abilities.ts';
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx';
import { ServerValue } from '../../ui/ServerValue.tsx';
import { TopBar } from '../dashboard/topBar/TopBar.tsx';
import { AbilityField, AbilityBackendErrors, Json } from './AbilityField.tsx';
import { RuleEditor } from './RuleEditor.tsx';
import { SettingsField } from '../settings/SettingsModuleForm.tsx';
import { EditingTargetLine } from '../profiles/EditingTargetLine.tsx';
import { TargetSourceError } from '../profiles/TargetSourceError.tsx';
import { editingTarget as targetCopy } from '../../copy/editingTarget.ts';
import { editingTargetVM } from '../../store/selectors/editingTarget.ts';
import './abilities.css';
import type { PageTarget } from '../../ui/routes.ts';

export function AbilitiesPage({
  abilities: store,
  target: routeTarget = null,
}: {
  readonly abilities: AbilitiesStore;
  readonly target?: PageTarget | null;
}) {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot),
    target = currentAbilities(s),
    e = currentAbility(s);
  const routeKey =
    routeTarget?.kind === 'ability' ? abilityKey(routeTarget.family, routeTarget.policy) : null;
  const openedRoute = useRef<string | null>(null);
  // RL11: wait for this target's source before selecting its specific policy.
  useEffect(() => {
    const marker = JSON.stringify([s.key, routeKey]);
    if (
      routeKey !== null &&
      target?.editors[routeKey] !== undefined &&
      openedRoute.current !== marker
    ) {
      openedRoute.current = marker;
      store.select(routeKey);
      document.getElementById('abilities-editor')?.focus();
    }
  }, [store, routeKey, s.key, target?.editors]);
  const problems = abilityProblems(e),
    errorSummary = useRef<HTMLElement>(null);
  const [family, setFamily] = useState<AbilityFamily>(
    routeTarget?.kind === 'ability' ? routeTarget.family : 'uw_policies',
  );
  const newId = target?.newIds[family] ?? '';
  const [now, setNow] = useState(Date.now),
    [confirm, setConfirm] = useState<{
      action: 'delete' | 'cancel';
      key: string | null;
      name: string | null;
      version: number;
    } | null>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (e?.deleting === true) document.getElementById('abilities-editor')?.focus();
  }, [e?.deleting]);
  useEffect(() => {
    if (e?.outcome === 'refused') errorSummary.current?.focus();
  }, [e?.outcome, e?.detail]);
  const raw = e === null ? undefined : abilityValue(e.node),
    cl = own(raw, 'chain_lightning');
  const clMode = text(own(cl, 'mode')) ?? 'absent';
  const armValue = own(raw, 'arm');
  const armMode =
    armValue === 'always'
      ? 'always'
      : own(armValue, 'on') === 'second_wind'
        ? 'second_wind'
        : 'unspecified';
  const secondWind = armMode === 'second_wind';
  const stale = target !== null && (target.readAt === null || now - target.readAt > 30_000);
  const readOnly = abilityReadOnly(s);
  const readUnavailable = target?.busy === true || s.context === null;
  const consumers = e === null || target === null ? [] : abilityConsumers(target, e);
  const name = abilityName(e?.id),
    globalKey = abilityKey('global', 'demon_mode_always');
  const globalField = abilityGlobalField(target, e);
  const editing = editingTargetVM(s.editing);
  const shownTarget = e?.family === 'global' ? editing.active : editing.name;
  return (
    <>
      <header className="tp-topbar">
        <TopBar title={t.pageName.short} readOnly />
      </header>
      <main id="main" tabIndex={-1} className="tp-main tp-abilities">
        <p>{t.intro.short}</p>
        <div className="tp-abilities__target">
          <strong>{t.target.short}</strong>
          {[s.context?.instance, s.context?.account, s.context?.profile].map((v, index) => {
            const shown = abilityName(v);
            return (
              <span key={index}>
                {shown === null ? t.unknown.short : <ServerValue kind="name" value={shown} />}
              </span>
            );
          })}
        </div>
        <p>{t.scope.short}</p>
        {/* F6-14-C-05: unavailable while a read runs, but never natively disabled: a person who
            pressed it keeps keyboard focus on it (a disabled button drops focus to the page). */}
        <button
          className="tp-button"
          type="button"
          onClick={() => {
            if (!readUnavailable) void store.refresh();
          }}
          aria-disabled={readUnavailable || undefined}
          aria-describedby={
            target?.busy === true
              ? 'abilities-read-reason'
              : s.context === null
                ? 'abilities-no-target'
                : undefined
          }
        >
          {t.read.short}
        </button>
        {target?.busy === true ? (
          <p id="abilities-read-reason" role="status">
            {t.reading.short}
          </p>
        ) : null}
        {target?.error === true ? <p role="alert">{t.readError.short}</p> : null}
        <TargetSourceError error={abilityMessage(target?.sourceError)} />
        {stale ? <p role="status">{t.stale.short}</p> : null}
        {s.editing.name === null || s.context === null ? (
          <p id="abilities-no-target">{t.noTarget.short}</p>
        ) : null}
        {readOnly ? <p role="status">{t.readOnly.short}</p> : null}
        <section
          className="tp-abilities__card"
          aria-labelledby="abilities-global"
          data-testid="abilities-active-only"
        >
          <h2 id="abilities-global">{t.global.short}</h2>
          <div className="tp-abilities__actions">
            {targetCopy.active.short}
            {editing.active === null ? (
              targetCopy.none.short
            ) : (
              <ServerValue kind="name" value={editing.active} />
            )}
          </div>
          {s.editing.inactive || target?.editors[globalKey] === undefined ? (
            <p id="abilities-global-reason">
              {s.editing.inactive ? t.activeOnly.short : t.globalUnavailable.short}
            </p>
          ) : null}
          <p>{t.overrideHelp.short}</p>
          <button
            type="button"
            className="tp-button"
            aria-pressed={target?.selected === globalKey}
            onClick={() => {
              store.select(globalKey);
            }}
            disabled={s.editing.inactive || target?.editors[globalKey] === undefined}
            aria-describedby={
              s.editing.inactive || target?.editors[globalKey] === undefined
                ? 'abilities-global-reason'
                : undefined
            }
          >
            {t.global.short}
          </button>
        </section>
        <EditingTargetLine />
        <div className="tp-abilities__layout">
          <aside className="tp-abilities__card" aria-labelledby="abilities-plans">
            <h2 id="abilities-plans">{t.plans.short}</h2>
            <label>
              {t.plans.short}
              <select
                value={family}
                onChange={(event) => {
                  setFamily(
                    event.target.value === 'uw_policies' ? 'uw_policies' : 'rescue_policies',
                  );
                }}
              >
                <option value="uw_policies">{t.uw.short}</option>
                <option value="rescue_policies">{t.rescue.short}</option>
              </select>
            </label>
            <ul className="tp-abilities__list">
              {Object.entries(target?.editors ?? {})
                .filter(([, entry]) => entry.family === family && !entry.deleting)
                .map(([key, entry]) => {
                  const label = abilityName(
                    text(own(abilityValue(entry.node), 'label')) ?? entry.id,
                  );
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        className="tp-button"
                        aria-pressed={target?.selected === key}
                        onClick={() => {
                          store.select(key);
                        }}
                      >
                        {label === null ? (
                          t.unknown.short
                        ) : (
                          <ServerValue kind="name" value={label} />
                        )}
                      </button>
                      {entry.dirty ? <span>{t.dirty.short}</span> : null}
                    </li>
                  );
                })}
            </ul>
            {Object.values(target?.editors ?? {}).some(
              (entry) => entry.family === family,
            ) ? null : (
              <p>{t.empty.short}</p>
            )}
            <label htmlFor="abilities-new-id">{t.id.short}</label>
            <input
              id="abilities-new-id"
              value={newId}
              disabled={s.key === null}
              aria-describedby="abilities-id-help"
              onChange={(event) => {
                store.newId(family, event.target.value);
              }}
            />
            <p id="abilities-id-help">{t.idHelp.short}</p>
            <button
              className="tp-button"
              type="button"
              disabled={newId === ''}
              onClick={() => {
                store.newId(family, '');
              }}
            >
              {t.discardId.short}
            </button>
            <div className="tp-abilities__actions">
              {([false, true] as const).map((copy) => (
                <button
                  key={String(copy)}
                  type="button"
                  className="tp-button"
                  disabled={
                    readOnly ||
                    target?.readAt == null ||
                    !/^[-\w]+$/.test(newId) ||
                    Object.hasOwn(target.editors, abilityKey(family, newId)) ||
                    (copy && e?.family !== family)
                  }
                  onClick={() => {
                    store.create(family, newId, copy);
                  }}
                >
                  {copy ? t.copy.short : t.create.short}
                </button>
              ))}
            </div>
          </aside>
          <section className="tp-abilities__card" aria-labelledby="abilities-editor">
            <h2 id="abilities-editor" tabIndex={-1}>
              {name === null ? t.plans.short : <ServerValue kind="name" value={name} />}
            </h2>
            {e === null ? null : (
              <>
                <div className="tp-abilities__actions">
                  {t.saveTarget.short}
                  {t.space}
                  {shownTarget === null ? (
                    targetCopy.none.short
                  ) : (
                    <ServerValue kind="name" value={shownTarget} />
                  )}
                </div>
                <p>{e.dirty ? t.dirty.short : t.clean.short}</p>
                <p>{t.consumers.short}</p>
                {consumers.length === 0 ? (
                  <p>{t.unused.short}</p>
                ) : (
                  <ul>
                    {consumers.map((id) => {
                      const shown = abilityName(id);
                      return shown === null ? null : (
                        <li key={id}>
                          <ServerValue kind="name" value={shown} />
                        </li>
                      );
                    })}
                  </ul>
                )}
                {problems.length === 0 ? null : (
                  <section
                    ref={errorSummary}
                    tabIndex={-1}
                    aria-labelledby="abilities-problem-heading"
                    className="tp-abilities__errors"
                  >
                    <h3 id="abilities-problem-heading">{t.problems.short}</h3>
                    <ul>
                      {problems.map((problem, index) => (
                        <li key={index}>
                          <a
                            href={`#${problem.fieldId}`}
                            onClick={(event) => {
                              event.preventDefault();
                              (
                                document.getElementById(problem.fieldId) ??
                                document.getElementById(abilityFieldId([]))
                              )?.focus();
                            }}
                          >
                            <ServerValue kind="message" value={problem.message} />
                          </a>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <fieldset id={abilityFieldId([])} tabIndex={-1} disabled={readOnly}>
                  <legend>
                    {e.family === 'global'
                      ? t.global.short
                      : e.family === 'uw_policies'
                        ? t.uw.short
                        : t.rescue.short}
                  </legend>
                  {e.family === 'global' ? (
                    globalField === null ? (
                      <p>{t.readError.short}</p>
                    ) : (
                      <SettingsField
                        field={globalField}
                        scope={s.key}
                        note={null}
                        onEdit={(_scope, _key, value) => {
                          store.edit([], abilityNode(value));
                        }}
                      />
                    )
                  ) : (
                    <>
                      <label>
                        {t.label.short}
                        <input
                          {...abilityErrorAttributes(problems, ['label'])}
                          value={text(own(raw, 'label')) ?? ''}
                          onChange={(event) => {
                            store.edit(['label'], abilityNode(event.target.value));
                          }}
                        />
                      </label>
                      <AbilityBackendErrors problems={problems} path={['label']} />
                      {e.family === 'uw_policies' ? (
                        <>
                          <details open>
                            <summary>{t.baseline.short}</summary>
                            <p>{t.owned.short}</p>
                            {vocabValues(target?.vocab, 'uw_names')
                              .filter((w) => w !== 'chain_lightning')
                              .map((weapon) => {
                                const owned =
                                  ownPath(target?.source, 'profile', 'player', 'uws', weapon) ===
                                  true;
                                return (
                                  <div key={weapon} className="tp-abilities__weapon">
                                    <AbilityField
                                      path={['baseline', weapon]}
                                      problems={problems}
                                      label={abilityLabel(weapon)}
                                      spec={{ type: 'bool' }}
                                      node={nodeAt(e.node, ['baseline', weapon])}
                                      onChange={(next) => {
                                        store.edit(['baseline', weapon], next);
                                      }}
                                    />
                                    {owned ? null : <p>{t.skipped.short}</p>}
                                  </div>
                                );
                              })}
                          </details>
                          <details open>
                            <summary>{t.cl.short}</summary>
                            <label>
                              {t.clMode.short}
                              <select
                                {...abilityErrorAttributes(problems, ['chain_lightning', 'mode'])}
                                value={clMode}
                                onChange={(event) => {
                                  store.switchMode(['chain_lightning'], event.target.value);
                                }}
                              >
                                <option value="absent">{t.absent.short}</option>
                                {vocabValues(target?.vocab, 'cl_modes').map((mode) => (
                                  <option key={mode} value={mode}>
                                    {abilityLabel(mode)}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <AbilityBackendErrors
                              problems={problems}
                              path={['chain_lightning', 'mode']}
                            />
                            <p>{t.ranges.short}</p>
                            {(clMode === 'fleet_marks'
                              ? ['pre_mark_waves', 'off_after_waves', 'always_on_above']
                              : clMode === 'off_until_wave'
                                ? ['on_above']
                                : []
                            ).map((key) => (
                              <AbilityField
                                path={['chain_lightning', key]}
                                problems={problems}
                                key={key}
                                label={abilityLabel(key)}
                                spec={{ type: 'list' }}
                                node={nodeAt(e.node, ['chain_lightning', key])}
                                onOptional={
                                  key === 'always_on_above'
                                    ? (enabled) => {
                                        store.optionalRange(['chain_lightning', key], enabled);
                                      }
                                    : undefined
                                }
                                onChange={(next) => {
                                  store.edit(['chain_lightning', key], next);
                                }}
                              />
                            ))}
                          </details>
                        </>
                      ) : (
                        <>
                          <details open>
                            <summary>{t.arm.short}</summary>
                            <label>
                              {t.armMode.short}
                              <select
                                {...abilityErrorAttributes(problems, ['arm', 'on'])}
                                value={armMode}
                                onChange={(event) => {
                                  store.switchMode(['arm'], event.target.value);
                                }}
                              >
                                <option value="unspecified">{t.unspecified.short}</option>
                                <option value="always">{t.always.short}</option>
                                <option value="second_wind">{t.secondWind.short}</option>
                              </select>
                            </label>
                            <AbilityBackendErrors problems={problems} path={['arm', 'on']} />
                            <p>{t.duration.short}</p>
                            {secondWind
                              ? ['watch_sec', 'immunity_sec'].map((key) => (
                                  <AbilityField
                                    path={['arm', key]}
                                    problems={problems}
                                    key={key}
                                    label={abilityLabel(key)}
                                    spec={{ type: 'float' }}
                                    node={nodeAt(e.node, ['arm', key])}
                                    onChange={(next) => {
                                      store.edit(['arm', key], next);
                                    }}
                                  />
                                ))
                              : null}
                            <label>
                              <input
                                {...abilityErrorAttributes(problems, ['end_sprint_after_sw'])}
                                type="checkbox"
                                checked={own(raw, 'end_sprint_after_sw') === true}
                                onChange={(event) => {
                                  store.edit(
                                    ['end_sprint_after_sw'],
                                    abilityNode(event.target.checked),
                                  );
                                }}
                              />
                              {t.endSprint.short}
                            </label>
                            <AbilityBackendErrors
                              problems={problems}
                              path={['end_sprint_after_sw']}
                            />
                            <p>{t.sprintHelp.short}</p>
                          </details>
                          <RuleEditor
                            store={store}
                            node={e.node}
                            vocab={target?.vocab}
                            problems={problems}
                          />
                        </>
                      )}
                    </>
                  )}
                </fieldset>
                <details open={e.review || e.outcome === 'conflict'}>
                  <summary>{t.compare.short}</summary>
                  <div className="tp-abilities__compare">
                    <section>
                      <h3>{t.original.short}</h3>
                      <Json value={e.original} />
                    </section>
                    <section>
                      <h3>{t.latest.short}</h3>
                      <Json value={target === null ? undefined : latestAbility(target, e)} />
                    </section>
                    <section>
                      <h3>{t.proposed.short}</h3>
                      <Json value={raw} />
                    </section>
                  </div>
                </details>
                {e.review ? (
                  <label>
                    <input
                      type="checkbox"
                      checked={e.reviewed}
                      onChange={(event) => {
                        store.review(event.target.checked);
                      }}
                    />
                    {t.review.short}
                  </label>
                ) : null}
                {e.review && !e.reviewed ? <p>{t.reviewNeeded.short}</p> : null}
                <div className="tp-abilities__actions">
                  <button
                    type="button"
                    className="tp-button"
                    data-tier="primary"
                    disabled={!canSaveAbility(s, now)}
                    onClick={() => {
                      store.save();
                    }}
                  >
                    {e.family === 'global' ? t.saveGlobal.short : t.save.short}
                  </button>
                  <button
                    type="button"
                    className="tp-button"
                    disabled={
                      (!e.dirty && Object.keys(e.stash).length === 0) ||
                      e.outcome === 'checking' ||
                      e.outcome === 'sending' ||
                      e.outcome === 'unknown'
                    }
                    onClick={() => {
                      setConfirm({
                        action: 'cancel',
                        key: s.key,
                        name: target?.selected ?? null,
                        version: e.version,
                      });
                    }}
                  >
                    {t.cancel.short}
                  </button>
                  {e.family === 'global' ? null : (
                    <button
                      type="button"
                      className="tp-button"
                      disabled={!canSaveAbility(s, now, true)}
                      onClick={() => {
                        setConfirm({
                          action: 'delete',
                          key: s.key,
                          name: target?.selected ?? null,
                          version: e.version,
                        });
                      }}
                    >
                      {t.delete.short}
                    </button>
                  )}
                </div>
                {e.dirty && !canSaveAbility(s, now) ? <p>{t.blocked.short}</p> : null}
                {e.blockedReason === undefined ? null : (
                  <p role="status">{t.targetCheck[e.blockedReason].short}</p>
                )}
                {e.outcome === null ? null : (
                  <p role="status">
                    {/* The target and the outcome are separate lines (each its own text). */}
                    <span className="tp-abilities__line">
                      {t.saveTarget.short}
                      {t.space}
                      {shownTarget === null ? (
                        targetCopy.none.short
                      ) : (
                        <ServerValue kind="name" value={shownTarget} />
                      )}
                    </span>
                    <span className="tp-abilities__line">
                      {e.isNew &&
                      e.submission?.deleted === true &&
                      (e.outcome === 'saved' || e.outcome === 'readApplied')
                        ? t.deletedDraft.short
                        : e.outcome === 'unknown'
                          ? t.unknownResult.short
                          : t[e.outcome].short}
                    </span>
                  </p>
                )}
                {e.detail === undefined ? null : <Json value={e.detail} />}
                {e.revision !==
                  sourceRevision(e.family === 'global' ? target?.settings : target?.source) ||
                e.outcome === 'conflict' ||
                e.outcome === 'refused' ||
                e.outcome === 'unknown' ? (
                  <button
                    type="button"
                    className="tp-button"
                    disabled={!canReconcileAbility(s, now)}
                    onClick={() => {
                      store.reconcile();
                    }}
                  >
                    {t.reconcile.short}
                  </button>
                ) : null}
              </>
            )}
          </section>
        </div>
        <details>
          <summary>{t.evidence.short}</summary>
          <p>{t.evidenceHelp.short}</p>
          <Json value={ownPath(target?.source, 'profile', 'player')} />
          <a href="/ui/index.html#screens">{t.recognition.short}</a>
        </details>
        {(['problems', 'warnings', 'validator_error'] as const).map((key) => {
          const values =
            key === 'validator_error'
              ? [own(target?.source, key)]
              : (list(own(target?.source, key)) ?? []);
          return (
            <section key={key}>
              <h2>
                {key === 'problems'
                  ? t.problems.short
                  : key === 'warnings'
                    ? t.warnings.short
                    : t.validator.short}
              </h2>
              {values.map((value, index) => {
                const shown = abilityMessage(value);
                return shown === null ? null : (
                  <p key={index}>
                    <ServerValue kind="message" value={shown} />
                  </p>
                );
              })}
            </section>
          );
        })}
        <p>{t.limit.short}</p>
        <ConfirmDialog
          open={confirm !== null}
          title={confirm?.action === 'delete' ? t.confirmDelete.short : t.cancelTitle.short}
          body={confirm?.action === 'delete' ? t.deleteHelp.short : t.cancelHelp.short}
          confirmLabel={confirm?.action === 'delete' ? t.delete.short : t.cancel.short}
          cancelLabel={t.keep.short}
          tier="primary"
          onCancel={() => {
            setConfirm(null);
          }}
          onConfirm={() => {
            const current = store.getSnapshot(),
              entry = currentAbility(current);
            if (
              current.key === confirm?.key &&
              currentAbilities(current)?.selected === confirm.name &&
              entry?.version === confirm.version
            ) {
              if (confirm.action === 'delete') store.save(true);
              else store.cancel();
            }
            setConfirm(null);
          }}
        />
      </main>
    </>
  );
}
