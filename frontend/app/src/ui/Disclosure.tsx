import { useEffect, useRef } from 'react';
import type { CopyNode, CopyText } from '../copy/text.ts';
import './ui.css';

export interface DisclosureProps {
  readonly label: CopyText;
  readonly count?: number;
  /** One line shown beside the label while closed. */
  readonly preview?: CopyNode;
  /** A stable key that survives polls (F-113). */
  readonly focusKey?: string;
  /**
   * Opens once, the first time this turns true (content needed to act, such as a problem
   * that arrives with a later read); a person's toggle wins from then on.
   */
  readonly initiallyOpen?: boolean;
  readonly children: CopyNode;
}

/**
 * Detail on demand (spec 3.5): native details and summary, so it works without
 * script and keeps its open state across renders while its key is stable.
 */
export function Disclosure({
  label,
  count,
  preview,
  focusKey,
  initiallyOpen = false,
  children,
}: DisclosureProps) {
  const details = useRef<HTMLDetailsElement | null>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (!initiallyOpen || opened.current || details.current === null) return;
    opened.current = true;
    details.current.open = true;
  }, [initiallyOpen]);
  return (
    <details className="tp-disclosure" ref={details}>
      <summary data-focus-key={focusKey}>
        <span>{label}</span>
        {count === undefined ? null : <span className="tp-disclosure__count">{count}</span>}
        {preview === undefined ? null : <span className="tp-disclosure__preview">{preview}</span>}
      </summary>
      <div className="tp-disclosure__body">{children}</div>
    </details>
  );
}
