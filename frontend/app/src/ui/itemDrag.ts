import type { DragEvent } from 'react';

/**
 * The drag payload of an item (a chip, a queue entry): its id, under a type of its own so
 * a dragged text selection or a file never lands in a queue. Pointer drag is a shortcut;
 * the same moves have buttons (PriorityQueue) and the chip's own toggle.
 */
const ITEM_DRAG_TYPE = 'application/x-tower-pilot-item';

export function startItemDrag(event: DragEvent, id: string): void {
  event.dataTransfer.setData(ITEM_DRAG_TYPE, id);
  event.dataTransfer.effectAllowed = 'move';
}

/** Whether the drag in progress carries an item (readable during dragover, unlike its id). */
export function isItemDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(ITEM_DRAG_TYPE);
}

/** The dragged item's id, readable on drop only; null when the payload is not an item. */
export function droppedItemId(event: DragEvent): string | null {
  const id = event.dataTransfer.getData(ITEM_DRAG_TYPE);
  return id === '' ? null : id;
}
