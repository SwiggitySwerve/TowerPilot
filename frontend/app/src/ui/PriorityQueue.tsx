import { useId, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { copy } from '../copy/catalogue.ts';
import type { CopyNode, CopyText } from '../copy/text.ts';
import { Glyph } from './ItemGlyph.tsx';
import { droppedItemId, isItemDrag, startItemDrag } from './itemDrag.ts';
import { useAnnounce } from './LiveRegion.tsx';
import type { ItemTone } from './ToggleChip.tsx';
import './items.css';

export interface QueueEntry {
  /** A stable id; it is the drag payload and the key. */
  readonly id: string;
  readonly label: CopyNode;
  readonly tone?: ItemTone;
}

export interface PriorityQueueProps {
  /** Names the list ("Priority queue"). */
  readonly label: CopyText;
  /** In order, first is highest priority. */
  readonly items: readonly QueueEntry[];
  /** The entry `id` goes to position `toIndex` (zero-based, as it will be after the move). */
  readonly onMove: (id: string, toIndex: number) => void;
  /** An item from outside the queue (a dragged chip) was dropped on it: add it at the end. */
  readonly onAdd?: (id: string) => void;
  readonly disabled?: boolean;
}

interface Pending {
  readonly id: string;
  readonly direction: 'up' | 'down';
}

/**
 * An ordered, numbered list of items. Each entry has a grip for pointer drag
 * (HTML5 drag and drop: drop on an entry to take its place, on the dashed end slot to
 * go last or, for an item from outside, to be added there) and Move up and Move down
 * buttons for everyone who cannot or would rather not drag (WCAG 2.5.7). The buttons
 * keep focus on the moved entry's same button and announce the new position. There is
 * no keyboard lift mode: the buttons are the keyboard path.
 */
export function PriorityQueue({
  label,
  items,
  onMove,
  onAdd,
  disabled = false,
}: PriorityQueueProps) {
  const announce = useAnnounce();
  const own = useId();
  const list = useRef<HTMLOListElement>(null);
  const pending = useRef<Pending | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [overEnd, setOverEnd] = useState(false);
  const order = items.map((item) => item.id).join('\n');

  // A moved entry's node is re-inserted, which drops focus in some browsers: put it back.
  useLayoutEffect(() => {
    const wanted = pending.current;
    pending.current = null;
    if (wanted === null) return;
    const button = Array.from(
      list.current?.querySelectorAll<HTMLElement>('[data-move-id]') ?? [],
    ).find(
      (candidate) =>
        candidate.dataset['moveId'] === wanted.id &&
        candidate.dataset['direction'] === wanted.direction,
    );
    if (button !== undefined && document.activeElement !== button) button.focus();
  }, [order]);

  function move(id: string, direction: 'up' | 'down') {
    const from = items.findIndex((item) => item.id === id);
    const to = direction === 'up' ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= items.length) return;
    pending.current = { id, direction };
    onMove(id, to);
    announce(copy.items.queue.moved(to + 1, items.length));
  }

  function clearOver() {
    setOver(null);
    setOverEnd(false);
  }

  function drop(event: DragEvent, targetIndex: number) {
    if (disabled || !isItemDrag(event)) return;
    event.preventDefault();
    const id = droppedItemId(event);
    clearOver();
    if (id === null) return;
    if (items.some((item) => item.id === id)) onMove(id, targetIndex);
    else onAdd?.(id);
  }

  function allow(event: DragEvent) {
    if (disabled || !isItemDrag(event)) return false;
    event.preventDefault();
    return true;
  }

  return (
    <ol
      ref={list}
      className="tp-queue"
      aria-label={label}
      data-drag-over={over !== null || overEnd ? 'true' : undefined}
    >
      {items.map((item, index) => {
        const nameId = `${own}-${String(index)}-name`;
        const upId = `${own}-${String(index)}-up`;
        const downId = `${own}-${String(index)}-down`;
        return (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Drag and drop is a pointer shortcut; Move up and Move down in the same entry are the accessible way (WCAG 2.5.7).
          <li
            key={item.id}
            className="tp-item tp-queue__item"
            data-tone={item.tone ?? 'neutral'}
            data-drop-target={over === item.id ? 'true' : undefined}
            draggable={disabled ? undefined : true}
            onDragStart={(event) => {
              startItemDrag(event, item.id);
            }}
            onDragOver={(event) => {
              if (allow(event)) setOver(item.id);
            }}
            onDragLeave={clearOver}
            onDragEnd={clearOver}
            onDrop={(event) => {
              drop(event, index);
            }}
          >
            <span className="tp-queue__grip">
              <Glyph kind="grip" />
            </span>
            <span className="tp-queue__position">{index + 1}</span>
            <span id={nameId} className="tp-queue__name">
              {item.label}
            </span>
            <span id={upId} className="tp-visually-hidden">
              {copy.items.queue.moveUp.short}
            </span>
            <button
              type="button"
              className="tp-item-button"
              data-move-id={item.id}
              data-direction="up"
              aria-labelledby={`${upId} ${nameId}`}
              aria-disabled={disabled || index === 0 ? true : undefined}
              onClick={() => {
                if (!disabled) move(item.id, 'up');
              }}
            >
              <Glyph kind="up" />
            </button>
            <span id={downId} className="tp-visually-hidden">
              {copy.items.queue.moveDown.short}
            </span>
            <button
              type="button"
              className="tp-item-button"
              data-move-id={item.id}
              data-direction="down"
              aria-labelledby={`${downId} ${nameId}`}
              aria-disabled={disabled || index === items.length - 1 ? true : undefined}
              onClick={() => {
                if (!disabled) move(item.id, 'down');
              }}
            >
              <Glyph kind="down" />
            </button>
          </li>
        );
      })}
      {disabled ? null : (
        <li
          className="tp-queue__end"
          aria-hidden="true"
          data-drop-target={overEnd ? 'true' : undefined}
          onDragOver={(event) => {
            if (allow(event)) setOverEnd(true);
          }}
          onDragLeave={clearOver}
          onDrop={(event) => {
            drop(event, items.length - 1);
          }}
        >
          {copy.items.queue.dropToAdd.short}
        </li>
      )}
    </ol>
  );
}
