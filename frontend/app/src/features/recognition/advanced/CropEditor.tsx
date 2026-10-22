import { useRef, useState } from 'react';
import { recognitionAdvanced as t } from '../../../copy/recognitionAdvanced.ts';
import { dragRect, draftRectangle, type CropDraft } from '../../../core/recognitionImages.ts';
import { own } from '../../../core/read.ts';
import { templateWriteAnswer, unknownWords } from '../../../core/recognition.ts';
import type {
  RecognitionAdvancedState,
  RecognitionAdvancedStore,
} from '../../../store/recognitionAdvanced.ts';
import { selectAdvanced } from '../../../store/selectors/recognitionAdvanced.ts';
import { Button } from '../../../ui/Button.tsx';
import { ConfirmDialog } from '../../../ui/ConfirmDialog.tsx';
import { Data } from './Data.tsx';
const fields = ['x', 'y', 'w', 'h'] as const;
export function CropEditor({
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
  const frame = target?.frame ?? null;
  const draft = target?.draft;
  const [fullSize, setFullSize] = useState(false);
  const start = useRef<{ x: number; y: number; token: string } | null>(null);
  const [replacement, setReplacement] = useState<{
    key: string;
    epoch: number;
    name: string;
    token: string;
    draft: CropDraft;
  } | null>(null);
  const answer = target?.crop?.answer == null ? null : templateWriteAnswer(target.crop.answer);
  const exists =
    draft !== undefined &&
    (vm.templates.have.includes(draft.name) ||
      (own(target?.crop?.answer?.body, 'exists') === true &&
        target?.crop?.meta.name === draft.name));
  const unavailable =
    state.context === null || !state.online || target?.checking === true || vm.cropPending;
  const reason =
    state.context === null
      ? t.noTarget.short
      : !state.online
        ? t.offline.short
        : target?.checking === true
          ? t.checking.short
          : vm.cropPending
            ? t.pending.short
            : vm.cropCheck.kind === 'invalid'
              ? t.validation[vm.cropCheck.reason].short
              : null;
  const takeBlocked = unavailable || target?.frameBusy === true;
  const validation = vm.cropCheck.kind === 'invalid' ? vm.cropCheck.reason : null;
  const overlay = draft === undefined ? null : draftRectangle(draft);
  return (
    <>
      <p>{t.still.short}</p>
      <p>{t.drag.short}</p>
      <Button
        tier="secondary"
        label={t.takeFrame.short}
        onClick={() => {
          void store.takeFrame();
        }}
        {...(takeBlocked ? { disabled: true, reasonId: 'frame-blocked' } : {})}
      />
      {takeBlocked ? <p id="frame-blocked">{reason ?? t.reading.short}</p> : null}
      {target?.frameError === true ? <p role="status">{t.frameError.short}</p> : null}
      {target?.contextError === true ? <p role="status">{t.contextError.short}</p> : null}
      {frame !== null ? (
        <>
          <p>{t.frameAge(Math.max(0, Math.floor((now - frame.takenAt) / 1000)))}</p>
          <p>
            {t.native.short}
            <Data value={frame.size} />
          </p>
          <Button
            tier="quiet"
            label={fullSize ? t.fitFrame.short : t.fullSize.short}
            onClick={() => {
              setFullSize((v) => !v);
            }}
          />
          <div
            className="tp-advanced__frame-scroll"
            role="region"
            aria-label={t.frameAlt.short}
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The scroll viewport needs keyboard focus (WCAG 2.1.1), verified in Playwright.
            tabIndex={0}
          >
            <div
              className="tp-advanced__crop-frame"
              data-full-size={fullSize}
              onPointerDown={(e) => {
                if (frame.size === null) return;
                const b = e.currentTarget.getBoundingClientRect();
                start.current = { x: e.clientX - b.left, y: e.clientY - b.top, token: frame.token };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const a = start.current;
                if (a === null || a.token !== frame.token || frame.size === null) return;
                const b = e.currentTarget.getBoundingClientRect();
                store.draw(
                  dragRect(
                    a,
                    { x: e.clientX - b.left, y: e.clientY - b.top },
                    { width: b.width, height: b.height },
                    frame.size,
                  ),
                );
              }}
              onPointerUp={(e) => {
                const a = start.current;
                if (a !== null && a.token === frame.token && frame.size !== null) {
                  const b = e.currentTarget.getBoundingClientRect();
                  store.draw(
                    dragRect(
                      a,
                      { x: e.clientX - b.left, y: e.clientY - b.top },
                      { width: b.width, height: b.height },
                      frame.size,
                    ),
                  );
                }
                start.current = null;
              }}
              onPointerCancel={() => {
                start.current = null;
              }}
            >
              <img
                key={frame.token}
                src={frame.src}
                alt={t.frameAlt.short}
                width={frame.size?.width}
                height={frame.size?.height}
                draggable={false}
                onLoad={(e) => {
                  store.frameLoaded(frame.token, {
                    width: e.currentTarget.naturalWidth,
                    height: e.currentTarget.naturalHeight,
                  });
                }}
                onError={() => {
                  store.frameFailed(frame.token);
                }}
              />
              {frame.size !== null ? (
                <svg
                  aria-hidden="true"
                  viewBox={`0 0 ${frame.size.width} ${frame.size.height}`}
                  preserveAspectRatio="none"
                >
                  {overlay === null ? null : (
                    <rect x={overlay.x} y={overlay.y} width={overlay.w} height={overlay.h} />
                  )}
                </svg>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
      <label className="tp-advanced__field">
        {t.target.short}
        <input
          id="recognition-crop-name"
          value={draft?.name ?? ''}
          aria-invalid={validation === 'name'}
          aria-describedby={validation === 'name' ? 'crop-validation' : undefined}
          onChange={(e) => {
            store.edit('name', e.target.value);
          }}
        />
      </label>
      <div className="tp-advanced__coordinates">
        {fields.map((field) => (
          <label className="tp-advanced__field" key={field}>
            {t[field].short}
            <input
              inputMode="numeric"
              value={draft?.[field] ?? ''}
              aria-invalid={validation === 'numbers' || validation === 'bounds'}
              aria-describedby={
                validation === 'numbers' || validation === 'bounds' ? 'crop-validation' : undefined
              }
              onChange={(e) => {
                store.edit(field, e.target.value);
              }}
              onKeyDown={(e) => {
                const value = draft?.[field];
                if (
                  (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
                  value !== undefined &&
                  /^\d+$/u.test(value)
                ) {
                  e.preventDefault();
                  store.edit(field, String(Number(value) + (e.key === 'ArrowUp' ? 1 : -1)));
                }
              }}
            />
          </label>
        ))}
      </div>
      {validation !== null ? <p id="crop-validation">{t.validation[validation].short}</p> : null}
      <Button
        tier="secondary"
        label={exists ? t.replace.short : t.save.short}
        onClick={() => {
          if (exists && frame !== null && state.key !== null)
            setReplacement({
              key: state.key,
              epoch: state.epoch,
              name: draft.name,
              token: frame.token,
              draft: { ...draft },
            });
          else void store.save();
        }}
        {...(reason !== null ? { disabled: true, reasonId: 'crop-save-blocked' } : {})}
      />
      {reason !== null ? <p id="crop-save-blocked">{reason}</p> : null}
      <ConfirmDialog
        open={
          replacement !== null && replacement.key === state.key && replacement.epoch === state.epoch
        }
        title={t.replace.short}
        body={
          <>
            <p>{t.replaceBody.short}</p>
            <Data value={replacement?.name} />
          </>
        }
        confirmLabel={t.replaceConfirm.short}
        cancelLabel={t.cancel.short}
        tier="primary"
        onCancel={() => {
          setReplacement(null);
        }}
        onConfirm={() => {
          const approved = replacement;
          setReplacement(null);
          if (approved !== null && approved.key === state.key && approved.epoch === state.epoch)
            void store.save(approved);
        }}
      />
      {target?.crop != null ? (
        <div role="status">
          <p>
            {answer?.kind === 'written'
              ? t.written.short
              : answer?.kind === 'refused'
                ? t.refused.short
                : target.crop.phase === 'sending'
                  ? t.sending.short
                  : t.unknown.short}
          </p>
          {answer?.kind === 'unknown' && target.crop.answer !== null ? (
            <Data value={unknownWords(target.crop.answer)} />
          ) : null}
          {answer?.kind === 'refused' ? (
            <>
              <Data value={answer.code} />
              <Data value={answer.error} />
            </>
          ) : null}
          {answer?.kind === 'written' ? (
            <>
              <p>
                <Data value={answer.rel} />
              </p>
              <p>
                {t.size.short}
                <Data value={[answer.width, answer.height]} />
              </p>
              <p>
                {t.secondBest.short}
                <Data value={answer.secondBest} />
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
