import type { CopyText } from '../copy/text.ts';
import './ui.css';

export interface PillProps {
  /** "Your choice:" or "Setting:"; a pill without one is a plain tag (see `KindTag`). */
  readonly prefix?: CopyText;
  readonly value: CopyText;
  /** "last read {age}" when the value is kept from an earlier read. */
  readonly age?: CopyText;
  /** `ok` tints the pill green for a tag that says something is in order. */
  readonly tone?: 'neutral' | 'ok';
  readonly id?: string;
}

/** A setting pill (spec 3.2): square, neutral, no dot; desired never looks like observed. */
export function Pill({ prefix, value, age, tone = 'neutral', id }: PillProps) {
  return (
    <span className="tp-pill" data-tone={tone === 'neutral' ? undefined : tone} id={id}>
      {prefix === undefined ? null : <span className="tp-pill__prefix">{prefix}</span>}
      <span className="tp-pill__value">{value}</span>
      {age === undefined ? null : <span className="tp-pill__age">{age}</span>}
    </span>
  );
}

export interface KindTagProps {
  readonly label: CopyText;
  readonly tone?: 'neutral' | 'ok';
}

/** A small tag naming the kind of a record ("Global preset"): a Pill with no prefix. */
export function KindTag({ label, tone }: KindTagProps) {
  return <Pill value={label} {...(tone === undefined ? {} : { tone })} />;
}
