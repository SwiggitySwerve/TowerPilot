import { recognitionAdvanced as t } from '../../../copy/recognitionAdvanced.ts';
import type { ServerText } from '../../../copy/server.ts';
import type { Rect, Size } from '../../../core/recognitionImages.ts';
import { ServerValue } from '../../../ui/ServerValue.tsx';
type Value = ServerText<'detail'> | number | null;
/** This scalar-only surface cannot brand arbitrary frontend objects as server text. */
export function Data({ value }: { readonly value: Value }) {
  return value === null ? (
    <span className="tp-advanced__value">{t.empty.short}</span>
  ) : typeof value === 'number' ? (
    <span className="tp-advanced__value">{value}</span>
  ) : (
    <ServerValue value={value} kind="detail" />
  );
}
export function Values({ values }: { readonly values: readonly Value[] }) {
  return values.length === 0 ? (
    <span className="tp-advanced__value">{t.empty.short}</span>
  ) : (
    <span className="tp-advanced__value">
      {values.map((value, i) => (
        <span key={i}>
          {i === 0 ? null : t.separator}
          <Data value={value} />
        </span>
      ))}
    </span>
  );
}
export function Dimensions({ value }: { readonly value: Size | null }) {
  return (
    <span className="tp-advanced__value">
      {value === null ? t.empty.short : t.dimensions(value.width, value.height)}
    </span>
  );
}
export function Coordinates({ value }: { readonly value: Rect | null }) {
  return value === null ? (
    <span className="tp-advanced__value">{t.empty.short}</span>
  ) : (
    <span className="tp-advanced__value">{t.coordinates(value.x, value.y, value.w, value.h)}</span>
  );
}
