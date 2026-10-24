import type { CopyEntry } from '../copy/text.ts';
import { Why } from './Why.tsx';
import './ui.css';

export interface CopyLineProps {
  readonly entry: CopyEntry;
}

/** One catalogue entry: the short line always visible, the "why" behind a disclosure. */
export function CopyLine({ entry }: CopyLineProps) {
  return (
    <div className="tp-copy-line">
      <p>{entry.short}</p>
      <Why why={entry.why} />
    </div>
  );
}
