import { useState } from 'react';
import type { CopyNode } from '../../../copy/text.ts';
import { recognitionAdvanced as t } from '../../../copy/recognitionAdvanced.ts';
import type {
  RecognitionAdvancedState,
  RecognitionAdvancedStore,
} from '../../../store/recognitionAdvanced.ts';
import { selectAdvanced, type AdvancedView } from '../../../store/selectors/recognitionAdvanced.ts';
import { Button } from '../../../ui/Button.tsx';
import { Coordinates, Data, Dimensions, Values } from './Data.tsx';
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
function Library({ folder, images }: Pick<AdvancedView['library'][number], 'folder' | 'images'>) {
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
          {images.map((image) => (
            <li key={image.key}>
              <Data value={image.name} />
              {image.src === null ? null : <Thumbnail key={image.src} src={image.src} />}
            </li>
          ))}
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
              <p>
                {t.source.short}
                <Data value={s.source} />
              </p>
              <p>
                {t.destination.short}
                <Data value={s.destination} />
              </p>
              <p>
                {t.action.short}
                <Data value={s.action} />
              </p>
              <p>
                {t.status.short}
                <Data value={s.status} />
              </p>
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
                  <Data value={s.label} />
                  {t.space}
                  <Data value={s.status} />
                </summary>
                <p>
                  {t.verified.short}
                  <Data value={s.verified} />
                </p>
                <p>
                  {t.total.short}
                  <Data value={s.total} />
                </p>
                <ul>
                  {s.controls.map((control) => (
                    <li key={control.id}>
                      <p>
                        <Data value={control.label} />
                      </p>
                      <p>
                        {t.status.short}
                        <Data value={control.status} />
                      </p>
                      <p>
                        {t.target.short}
                        <Data value={control.template} />
                      </p>
                      {control.optional === true ? <p>{t.optional.short}</p> : null}
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      </Disclosure>
      <Disclosure title={t.plan.short}>
        <p>{t.optional.short}</p>
        <p>
          {t.native.short}
          <Dimensions value={vm.plan.native} />
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
                <li key={target.key}>
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
                    <Dimensions value={target.reference} />
                  </p>
                  {target.learned !== null ? (
                    <p>
                      {t.learned.short}
                      <Coordinates value={target.learned} />
                      <Dimensions value={target.learnedSize} />
                    </p>
                  ) : null}
                  <Button
                    tier="quiet"
                    label={t.repair.short}
                    onClick={() => {
                      store.repair(target.repair);
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
          {vm.required.map((r) => (
            <li key={r.key}>
              <p>
                <Data value={r.rel} />
              </p>
              <p>
                {t.feature.short}
                <Data value={r.feature} />
              </p>
              <p>
                {r.have === null ? t.unavailable.short : r.have ? t.have.short : t.missing.short}
              </p>
              <p>
                {t.note.short}
                <Data value={r.note} />
              </p>
              <p>
                {t.usedBy.short}
                <Values values={r.usedBy} />
              </p>
              <Button
                tier="quiet"
                label={t.repair.short}
                onClick={() => {
                  store.repair(r.repair);
                  document.getElementById('recognition-crop-title')?.focus();
                }}
              />
            </li>
          ))}
        </ul>
      </Disclosure>
      <Disclosure title={t.missingSeen.short}>
        <Values values={vm.missingSeen} />
      </Disclosure>
      <Disclosure title={t.catalogue.short}>
        <ul>
          {vm.catalogue.map((m) => (
            <li key={m.key}>
              <p>
                {t.name.short}
                <Data value={m.name} />
              </p>
              <p>
                {t.slug.short}
                <Data value={m.slug} />
              </p>
              <p>
                {t.abbrevs.short}
                <Values values={m.abbrevs} />
              </p>
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
        {vm.library.map((g) => (
          <Library key={g.key} folder={g.folder} images={g.images} />
        ))}
      </Disclosure>
    </>
  );
}
