import { copy } from '../copy/catalogue.ts';
import type { CopyNode } from '../copy/text.ts';
import { Glyph, Mark } from './ItemGlyph.tsx';
import './items.css';

export interface MarkChipProps {
  /** The name, on one line and cut with an ellipsis when it does not fit. */
  readonly label: CopyNode;
  /** In use: the cell takes the green tint and the check. */
  readonly active?: boolean;
  /** Mastered: the star. */
  readonly mastered?: boolean;
}

/**
 * A read-only cell of a ChipGrid (`size="cell"`): a name and two fixed mark slots,
 * the check always first and the star always second, so marks line up down the grid.
 * Each mark is an image with its catalogue name; an empty slot keeps its width.
 */
export function MarkChip({ label, active = false, mastered = false }: MarkChipProps) {
  return (
    <li className="tp-item tp-mark-chip" data-tone="ok" data-on={active ? 'true' : 'false'}>
      <span className="tp-mark-chip__name">{label}</span>
      <span className="tp-mark-chip__marks">
        {active ? <Mark kind="check" label={copy.items.marks.active.short} /> : <span />}
        {mastered ? <Mark kind="star" label={copy.items.marks.mastered.short} /> : <span />}
      </span>
    </li>
  );
}

export interface MarkLegendProps {
  /** Whether any cell of the grid carries the check. */
  readonly active: boolean;
  /** Whether any cell of the grid carries the star. */
  readonly mastered: boolean;
}

/**
 * What the marks mean, drawn only for the marks the grid actually shows: nothing is
 * rendered when no cell is marked, so an unmarked grid carries no legend.
 */
export function MarkLegend({ active, mastered }: MarkLegendProps) {
  if (!active && !mastered) return null;
  return (
    <ul className="tp-mark-legend" aria-label={copy.items.legend.short}>
      {active ? (
        <li>
          <span className="tp-mark" data-mark="check" aria-hidden="true">
            <Glyph kind="check" />
          </span>
          {copy.items.marks.active.short}
        </li>
      ) : null}
      {mastered ? (
        <li>
          <span className="tp-mark" data-mark="star" aria-hidden="true">
            <Glyph kind="star" />
          </span>
          {copy.items.marks.mastered.short}
        </li>
      ) : null}
    </ul>
  );
}
