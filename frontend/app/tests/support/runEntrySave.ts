import { within } from '@testing-library/react';

/** The names of the entry groups' one Save each (Identity, Entry behavior, Policies). */
export const ENTRY_SAVE = /^Save (identity|entry behavior|policies)$/u;

function group(key: string): HTMLElement {
  const section = document
    .querySelector(`[data-entry-field="${key}"]`)
    ?.closest<HTMLElement>('[data-entry-section]');
  if (section === null || section === undefined) throw new Error(`missing entry group of ${key}`);
  return section;
}

/** The Save of the entry group that holds field `key`: it saves the group's changed fields. */
export function entrySave(key: string): HTMLElement {
  return within(group(key)).getByRole('button', { name: ENTRY_SAVE });
}

/** The Discard of the entry group that holds field `key`. */
export function entryDiscard(key: string): HTMLElement {
  return within(group(key)).getByRole('button', { name: 'Discard changes' });
}
