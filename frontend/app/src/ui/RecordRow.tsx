import { copy } from '../copy/catalogue.ts';
import type { CopyNode } from '../copy/text.ts';
import './items.css';

export interface RecordRowProps {
  /** The record's name, in bold. */
  readonly name: CopyNode;
  /** A `KindTag` or a `StatusDot`, drawn right after the name. */
  readonly kind?: CopyNode;
  /** One muted line after the tag. */
  readonly summary?: CopyNode;
  /** The names of what uses this record; the row says "Used by" and lists them. */
  readonly usedBy?: readonly CopyNode[];
  /** The row's actions, at its end (Edit, Copy, Delete). */
  readonly actions?: CopyNode;
}

/**
 * One record of a library as one compact line that wraps when it must: bold name, an
 * optional kind tag, a muted summary, who uses it, and its actions pushed to the end.
 * It draws no box of its own; a list or a tile around it provides the surface.
 */
export function RecordRow({ name, kind, summary, usedBy, actions }: RecordRowProps) {
  const used = usedBy ?? [];
  return (
    <div className="tp-record-row">
      <strong className="tp-record-row__name">{name}</strong>
      {kind}
      {summary === undefined ? null : <span className="tp-record-row__summary">{summary}</span>}
      {used.length === 0 ? null : (
        <span className="tp-record-row__summary tp-record-row__used">
          <span>{copy.items.record.usedBy.short}</span>
          <span>
            {used.map((who, index) => (
              <span key={index}>
                {index === 0 ? null : copy.items.record.separator.short}
                {who}
              </span>
            ))}
          </span>
        </span>
      )}
      {actions === undefined ? null : <span className="tp-record-row__actions">{actions}</span>}
    </div>
  );
}
