import { entry, made } from './entry.ts';
import type { CopyText } from './text.ts';

/**
 * Words of the shared item primitives in src/ui (ToggleChip, MarkChip, PriorityQueue,
 * RecordRow, StatusDot, CompactField). The wording of a page's own items (an upgrade's
 * name, a field's meaning) stays with the page; only the generic marks and actions live here.
 */
export const items = {
  marks: {
    /** The mark of a chip that is switched on or a name that is in use. */
    active: entry('Active'),
    mastered: entry('Mastered'),
    unsupported: entry('Unsupported'),
    invalid: entry('Needs attention'),
  },
  legend: entry('Marks'),
  queue: {
    moveUp: entry('Move up'),
    moveDown: entry('Move down'),
    dropToAdd: entry('Drop here to add to the end'),
    /** The live-region line after Move up or Move down. */
    moved: (position: number, total: number) =>
      made(`Moved to position ${String(position)} of ${String(total)}`),
  },
  /** The text that precedes the item's name in a chip field's accessible name ("Tap limit: Item"). */
  fieldName: (field: CopyText) => made(`${field}:`),
  record: {
    usedBy: entry('Used by'),
    separator: entry(', '),
  },
  compactField: {
    saving: entry('Saving'),
  },
  dot: {
    ok: entry('OK'),
    warn: entry('Warning'),
    bad: entry('Problem'),
    unknown: entry('Unknown'),
  },
};
