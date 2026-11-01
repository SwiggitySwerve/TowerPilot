import type { Locator } from '@playwright/test';

/** The names of the entry groups' one Save each (Identity, Entry behavior, Policies). */
export const ENTRY_SAVE = /^Save (identity|entry behavior|policies)$/;

/** The Save of the entry group that holds `field` (a `[data-entry-field]` locator). */
export function entrySave(field: Locator): Locator {
  return field
    .locator('xpath=ancestor::*[@data-entry-section][1]')
    .getByRole('button', { name: ENTRY_SAVE });
}
