import { useState } from 'react';
import type { CopyNode } from '../../../copy/text.ts';
import { recognitionAdvanced as t } from '../../../copy/recognitionAdvanced.ts';
import { imagePath } from '../../../core/recognitionImages.ts';
import type {
  RecognitionAdvancedState,
  RecognitionAdvancedStore,
} from '../../../store/recognitionAdvanced.ts';
import { selectAdvanced } from '../../../store/selectors/recognitionAdvanced.ts';
import { Button } from '../../../ui/Button.tsx';
import { Data } from './Data.tsx';
/** Closed diagnostic groups do not mount the full catalogue or its image elements. */
function Disclosure({
  title,
  children,
}: {
  readonly title: CopyNode;
  readonly children: CopyNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
      }}
    >
      <summary>{title}</summary>
      {open ? children : null}
    </details>
  );
}
function Thumbnail({ src }: { readonly src: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <p role="status">{t.libraryError.short}</p>
  ) : (
    <img
      src={src}
      alt={t.library.short}
      loading="lazy"
      onError={() => {
        setFailed(true);
      }}
    />
  );
}
function Library({
  folder,
  images,
  version,
}: {
  readonly folder: string;
  readonly images: readonly string[];
  readonly version: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
      }}
    >
      <summary>
        <Data value={folder} />
      </summary>
      {open ? (
        <ul className="tp-advanced__library">
          {images.map((rel) => {
            const src = imagePath(rel);
            return (
              <li key={rel}>
                <Data value={rel} />
                {src === null ? null : (
                  <Thumbnail
                    key={`${rel}:${version}`}
                    src={`${src}?v=${encodeURIComponent(version)}`}
                  />
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </details>
  );
}
export function Coverage({
  store,
  state,
  now,
}: {
  readonly store: RecognitionAdvancedStore;
  readonly state: RecognitionAdvancedState;
  readonly now: number;
}) {
  const vm = selectAdvanced(state, now);
  const target = vm.target;
  return (
    <>
      <Button
        tier="quiet"
        label={t.readCoverage.short}
        onClick={() => {
          void store.refresh();
        }}
        {...(state.context === null || target?.busy === true
          ? { disabled: true, reasonId: 'coverage-blocked' }
          : {})}
      />
      {state.context === null || target?.busy === true ? (
        <p id="coverage-blocked">{state.context === null ? t.noTarget.short : t.reading.short}</p>
      ) : null}
      {target?.readError === true ? <p role="status">{t.readError.short}</p> : null}
      {vm.stale ? <p>{t.stale.short}</p> : null}
      <p>{t.missingWarning.short}</p>
      <p>
        <Data value={vm.plan.note} />
      </p>
      <Disclosure title={t.mapping.short}>
        <ul>
          {vm.plan.mapping.map((s) => (
            <li key={s.id}>
              <Data value={s} />
            </li>
          ))}
        </ul>
      </Disclosure>
      <Disclosure title={t.interface.short}>
        <ul>
          {vm.plan.interface.map((s) => (
            <li key={s.id}>
              <details>
                <summary>
                  <Data
                    value={{
                      screen: s.label,
                      status: s.status,
                      verified: s.verified,
                      total: s.total,
                    }}
                  />
                </summary>
                <Data value={s.controls} />
              </details>
            </li>
          ))}
        </ul>
      </Disclosure>
      <Disclosure title={t.plan.short}>
        <p>{t.optional.short}</p>
        <p>
          {t.native.short}
          <Data value={vm.plan.native} />
        </p>
        {vm.plan.steps.map((s) => (
          <details key={s.id}>
            <summary>
              <Data value={s.title} />
            </summary>
            <p>
              <Data value={s.instructions} />
            </p>
            <p>
              <Data value={s.mode} />
            </p>
            <ul>
              {s.targets.map((target) => (
                <li key={target.rel}>
                  <p>
                    <Data value={target.label} />
                    <Data value={target.rel} />
                  </p>
                  <p>
                    <Data value={target.status} />
                  </p>
                  <p>
                    {target.required === null
                      ? t.unavailable.short
                      : target.required
                        ? t.required.short
                        : t.notRequired.short}
                    {t.space}
                    {target.automatic === null
                      ? t.unavailable.short
                      : target.automatic
                        ? t.automatic.short
                        : t.manual.short}
                  </p>
                  <p>
                    {t.reference.short}
                    <Data value={target.reference} />
                  </p>
                  {target.learned !== null ? (
                    <p>
                      {t.learned.short}
                      <Data value={target.learned} />
                      <Data value={target.learnedSize} />
                    </p>
                  ) : null}
                  <Button
                    tier="quiet"
                    label={t.repair.short}
                    onClick={() => {
                      store.repair(target);
                      document.getElementById('recognition-crop-title')?.focus();
                    }}
                  />
                </li>
              ))}
            </ul>
          </details>
        ))}
      </Disclosure>
      <Disclosure title={t.requiredImages.short}>
        <ul>
          {vm.required.rows.map((r) => (
            <li key={r.rel}>
              <Data value={r} />
              <Button
                tier="quiet"
                label={t.repair.short}
                onClick={() => {
                  store.repair({
                    rel: r.rel,
                    label: r.feature ?? r.rel,
                    status: null,
                    required: true,
                    automatic: false,
                    learned: null,
                    learnedSize: null,
                    reference: null,
                  });
                  document.getElementById('recognition-crop-title')?.focus();
                }}
              />
            </li>
          ))}
        </ul>
      </Disclosure>
      <Disclosure title={t.missingSeen.short}>
        <Data value={vm.templates.missingSeen} />
      </Disclosure>
      <Disclosure title={t.catalogue.short}>
        <ul>
          {vm.catalogue.map((m) => (
            <li key={m.slug}>
              <Data value={{ name: m.name, slug: m.slug, abbrevs: m.abbrevs }} />
              {m.learned === null
                ? t.unavailable.short
                : m.learned
                  ? t.learnedFlag.short
                  : t.notLearned.short}
            </li>
          ))}
        </ul>
      </Disclosure>
      <Disclosure title={t.library.short}>
        {vm.templates.groups.map((g) => (
          <Library
            key={`${state.key}:${state.epoch}:${g.folder}`}
            {...g}
            version={`${state.key}:${state.epoch}:${target?.imageRevision ?? 0}:${target?.readAt ?? 0}`}
          />
        ))}
      </Disclosure>
    </>
  );
}
