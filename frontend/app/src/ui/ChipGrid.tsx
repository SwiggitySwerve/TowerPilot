import type { CopyNode, CopyText } from '../copy/text.ts';
import './items.css';

export interface ChipGridProps {
  /** Names the list for assistive technology (a section's name, "Attack"). */
  readonly label: CopyText;
  /** `toggle`: boxes of one fixed height (ToggleChip); `cell`: one-line cells (MarkChip). */
  readonly size?: 'toggle' | 'cell';
  /** `ToggleChip` or `MarkChip` items, every one of them: the grid never folds. */
  readonly children: CopyNode;
}

/**
 * A plain list of items on a grid whose columns come from the container's width
 * (as many as fit). It is a list of toggle buttons, not a composite widget: there is
 * no roving tabindex, so Tab visits each chip and Space or Enter toggles it (WAI-ARIA
 * APG: toggle buttons need no arrow-key model). Chips of one grid share one box.
 */
export function ChipGrid({ label, size = 'toggle', children }: ChipGridProps) {
  return (
    <ul className="tp-chip-grid" data-size={size} aria-label={label}>
      {children}
    </ul>
  );
}
