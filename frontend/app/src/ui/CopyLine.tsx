import type { ReactElement } from 'react';
import { splitLastWord } from '../copy/catalogue.ts';
import type { CopyEntry, CopyText } from '../copy/text.ts';
import { Why } from './Why.tsx';
import './ui.css';

/** body: a plain line; intro: under a title; note: beside controls. */
export type CopyLineVariant = 'body' | 'intro' | 'note';

export interface CopyLineProps {
  readonly entry: CopyEntry;
  /** intro and note draw the line and its help icon on one muted line (default body). */
  readonly variant?: CopyLineVariant;
}

/** The line's last word and its help icon never part: the icon never wraps onto a line alone. */
function WithWhy({ text, why }: { readonly text: CopyText; readonly why: ReactElement }) {
  const [head, last] = splitLastWord(text);
  return (
    <>
      {head}
      <span className="tp-copy-line__tail">
        {last}
        {why}
      </span>
    </>
  );
}

/** One catalogue entry: the short line always visible, background in a help icon. */
export function CopyLine({ entry, variant = 'body' }: CopyLineProps) {
  return (
    <div className="tp-copy-line" data-variant={variant === 'body' ? undefined : variant}>
      <p>
        {entry.why === undefined ? (
          entry.short
        ) : (
          <WithWhy text={entry.short} why={<Why subject={entry.short} why={entry.why} />} />
        )}
      </p>
    </div>
  );
}
