import { copy } from '../copy/catalogue.ts';
import type { CopyText } from '../copy/text.ts';
import './ui.css';

export interface WhyProps {
  readonly why: CopyText | undefined;
}

/** The "why" behind a short line, folded behind a disclosure. Renders nothing without one. */
export function Why({ why }: WhyProps) {
  if (why === undefined) {
    return null;
  }
  return (
    <details className="tp-copy-line__why">
      <summary>{copy.common.why.short}</summary>
      <p>{why}</p>
    </details>
  );
}
