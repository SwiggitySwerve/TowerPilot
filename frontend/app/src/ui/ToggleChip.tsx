import { useId } from 'react';
import { copy } from '../copy/catalogue.ts';
import type { CopyNode } from '../copy/text.ts';
import { Glyph, Mark } from './ItemGlyph.tsx';
import { startItemDrag } from './itemDrag.ts';
import './items.css';

/** The colour of an item's section: its edge and the tint of its "on" state. */
export type ItemTone = 'attack' | 'defense' | 'utility' | 'neutral';

/** A disabled chip always names the visible element that says why (spec 3.3, 8.6). */
type Availability =
  | { readonly disabled?: false; readonly reasonId?: undefined }
  | { readonly disabled: true; readonly reasonId: string };

export type ToggleChipProps = Availability & {
  readonly tone: ItemTone;
  /** The item's name; it never changes with the state (the state is `aria-pressed`). */
  readonly label: CopyNode;
  readonly pressed: boolean;
  readonly onToggle: (pressed: boolean) => void;
  /** Extra marks after the state mark (a star, a count). */
  readonly marks?: CopyNode;
  /** The item cannot be recognised or used here: it is marked and cannot be switched. */
  readonly unsupported?: boolean;
  /** The id of the visible line that says why the item's settings are invalid. */
  readonly invalidReasonId?: string;
  /**
   * Inline fields (tap limit, weight), drawn beside the toggle and only while it is on.
   * They are siblings of the toggle button, never inside it; `nameId` is the id of the
   * element that names the item, for each field's accessible name.
   */
  readonly controls?: (nameId: string) => CopyNode;
  /** Makes the chip a drag source for a PriorityQueue (the toggle button stays the way to select it). */
  readonly dragId?: string;
  readonly describedBy?: string;
  readonly focusKey?: string;
};

/**
 * One switchable item of a ChipGrid: an outlined box with a real toggle button
 * (`aria-pressed`) and, while it is on, its inline fields as siblings of that
 * button. Every chip of a grid has the grid's one width and height. Off, on,
 * disabled, unsupported and invalid are told in marks and text, not only in colour.
 */
export function ToggleChip(props: ToggleChipProps) {
  const {
    tone,
    label,
    pressed,
    onToggle,
    marks,
    unsupported = false,
    invalidReasonId,
    controls,
    dragId,
    describedBy,
    focusKey,
  } = props;
  const nameId = useId();
  const blocked = props.disabled === true || unsupported;
  const invalid = invalidReasonId !== undefined;
  const described = [
    props.disabled === true ? props.reasonId : undefined,
    invalidReasonId,
    describedBy,
  ]
    .filter((value) => value !== undefined)
    .join(' ');
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Drag is a pointer shortcut on the chip; the toggle button inside is the accessible way to select it.
    <li
      className="tp-item tp-toggle-chip"
      data-tone={tone}
      data-on={pressed && !unsupported ? 'true' : 'false'}
      data-disabled={blocked ? 'true' : undefined}
      data-invalid={invalid ? 'true' : undefined}
      draggable={dragId !== undefined && !blocked ? true : undefined}
      onDragStart={
        dragId === undefined
          ? undefined
          : (event) => {
              startItemDrag(event, dragId);
            }
      }
    >
      <button
        type="button"
        className="tp-toggle-chip__button"
        aria-pressed={pressed}
        aria-disabled={blocked ? true : undefined}
        aria-describedby={described === '' ? undefined : described}
        data-focus-key={focusKey}
        onClick={() => {
          if (!blocked) onToggle(!pressed);
        }}
      >
        <span id={nameId} className="tp-toggle-chip__name">
          {label}
        </span>
        <span className="tp-toggle-chip__marks">
          {unsupported ? <Mark kind="question" label={copy.items.marks.unsupported.short} /> : null}
          {invalid ? <Mark kind="warning" label={copy.items.marks.invalid.short} /> : null}
          {marks}
          <span className="tp-mark" data-mark={pressed ? 'check' : 'ring'} aria-hidden="true">
            <Glyph kind={pressed ? 'check' : 'ring'} />
          </span>
        </span>
      </button>
      {pressed && !unsupported && controls !== undefined ? (
        <div className="tp-toggle-chip__controls">{controls(nameId)}</div>
      ) : null}
    </li>
  );
}
