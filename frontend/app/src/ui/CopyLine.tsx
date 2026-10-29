import type { CopyEntry } from '../copy/text.ts';
import { Why } from './Why.tsx';
import './ui.css';

/** body: a plain line; intro: under a title; note: beside controls. */
export type CopyLineVariant = 'body' | 'intro' | 'note';

export interface CopyLineProps {
  readonly entry: CopyEntry;
  /** intro and note draw the line and its Why on one muted line (default body). */
  readonly variant?: CopyLineVariant;
}

/** One catalogue entry: the short line always visible, the "why" behind a disclosure. */
export function CopyLine({ entry, variant = 'body' }: CopyLineProps) {
  return (
    <div className="tp-copy-line" data-variant={variant === 'body' ? undefined : variant}>
      <p>{entry.short}</p>
      <Why why={entry.why} />
    </div>
  );
}
