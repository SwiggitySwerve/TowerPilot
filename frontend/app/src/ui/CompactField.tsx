import { useId, useState } from 'react';
import { copy } from '../copy/catalogue.ts';
import type { CopyNode, CopyText } from '../copy/text.ts';
import './items.css';

export interface CompactFieldProps {
  readonly label: CopyText;
  /** The saved value; the field shows a draft until it is saved, then follows this again. */
  readonly value: string;
  /** Called on blur and on Enter when the draft differs from `value`. There is no Save button. */
  readonly onSave: (value: string) => void;
  readonly type?: 'text' | 'number';
  /** A save is in flight: the field is read-only and says so. */
  readonly pending?: boolean;
  /** Why the last save failed (undefined: it did not); the field stays editable and Enter tries again. */
  readonly error?: CopyNode;
  readonly id?: string;
}

/**
 * A label and a field on one line that saves where a person expects it to: leaving the
 * field or pressing Enter. Escape puts the saved value back. While a save runs the field
 * is read-only (never disabled, so focus stays) and says "Saving"; a refused save shows
 * its reason beside the field and keeps the draft.
 */
export function CompactField({
  label,
  value,
  onSave,
  type = 'text',
  pending = false,
  error,
  id,
}: CompactFieldProps) {
  const own = useId();
  const inputId = id ?? `${own}-input`;
  const errorId = `${own}-error`;
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  const [submitted, setSubmitted] = useState<string | null>(null);
  if (value !== seen) {
    // The saved value moved (a save landed, another editor wrote): follow it.
    setSeen(value);
    setDraft(value);
    setSubmitted(null);
  }
  const failed = error !== undefined;

  function commit(retry: boolean) {
    if (pending || draft === value) return;
    if (!retry && draft === submitted) return;
    setSubmitted(draft);
    onSave(draft);
  }

  return (
    <span
      className="tp-compact-field"
      data-state={pending ? 'pending' : failed ? 'error' : undefined}
    >
      <label htmlFor={inputId} className="tp-compact-field__label">
        {label}
      </label>
      <input
        id={inputId}
        type={type}
        className="tp-field-control tp-compact-field__input"
        value={draft}
        readOnly={pending}
        aria-busy={pending ? true : undefined}
        aria-invalid={failed ? true : undefined}
        aria-describedby={failed ? errorId : undefined}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
        }}
        onBlur={() => {
          commit(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit(true);
          } else if (event.key === 'Escape') {
            setDraft(value);
            setSubmitted(null);
          }
        }}
      />
      {pending ? (
        <span className="tp-compact-field__note">{copy.items.compactField.saving.short}</span>
      ) : null}
      {failed ? (
        <span id={errorId} className="tp-compact-field__note" data-tone="bad">
          {error}
        </span>
      ) : null}
    </span>
  );
}
