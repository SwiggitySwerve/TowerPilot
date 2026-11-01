import { useId } from 'react';
import { copy } from '../copy/catalogue.ts';
import type { CopyText } from '../copy/text.ts';
import './items.css';

export interface ChipFieldProps {
  /** The field's name ("Tap limit"); the accessible name is "<field>: <item>". */
  readonly label: CopyText;
  /** The id of the element that names the item (ToggleChip hands it to `controls`). */
  readonly itemId: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** What an empty field means, in one glyph or word ("∞" for no limit). */
  readonly placeholder?: CopyText;
  readonly min?: number;
  readonly max?: number;
  readonly invalid?: boolean;
  /** The id of the visible line that explains an invalid value. */
  readonly errorId?: string;
  readonly disabled?: boolean;
  readonly id?: string;
}

/**
 * A compact number field for inside a chip's controls. It has no visible label (the
 * chip's name is the context); its accessible name joins the field name and the item
 * name, so a list of them is never a run of unnamed fields.
 */
export function ChipField({
  label,
  itemId,
  value,
  onChange,
  placeholder,
  min,
  max,
  invalid = false,
  errorId,
  disabled = false,
  id,
}: ChipFieldProps) {
  const labelId = `${useId()}-label`;
  return (
    <>
      <span id={labelId} className="tp-visually-hidden">
        {copy.items.fieldName(label)}
      </span>
      <input
        type="number"
        inputMode="numeric"
        step={1}
        id={id}
        className="tp-chip-field"
        aria-labelledby={`${labelId} ${itemId}`}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={errorId}
        placeholder={placeholder}
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
    </>
  );
}
