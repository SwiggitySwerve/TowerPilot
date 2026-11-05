import { expect, type Locator } from '@playwright/test';
import { own } from '../../../src/core/read.ts';
import { shopCatalog } from '../../../src/core/shoppingPlan.ts';
import { dashboardPagesCase } from '../../support/dashboardFixture.ts';
import { boundsDraft } from '../../support/shoppingBounds.ts';
import { showShopPage } from './helpers.ts';

const LABELS: Readonly<Record<string, string>> = {
  tap_limit: 'Tap attempts this battle',
  weight: 'Weight',
  from_wave: 'From wave',
  until_wave: 'Until wave (exclusive)',
};
const CATALOG = shopCatalog(
  own(dashboardPagesCase('shopping_queue.shopping_read_before_any_save').body, 'catalog'),
);

/** An upgrade's field: a chip's number box or a wave range box, named "<field>: <upgrade>". */
function field(editor: Locator, key: string) {
  const [, id = '', name = ''] = key.split(':');
  const upgrade = CATALOG.find((item) => item.id === id)?.label ?? id;
  return editor.getByRole('spinbutton', { name: `${LABELS[name] ?? ''}: ${upgrade}`, exact: true });
}

/** A chip's own number box is on its shop page: show that page (wave ranges sit in the queue). */
async function onItsPage(editor: Locator, key: string) {
  const [, id = '', name = ''] = key.split(':');
  const section = CATALOG.find((item) => item.id === id)?.section;
  if ((name === 'tap_limit' || name === 'weight') && section != null)
    await showShopPage(editor, section);
}

/** Weight shows only in Weighted split; wave fields are always on queued rows. */
async function revealed(editor: Locator, act: () => Promise<void>) {
  const mode = editor.getByLabel('Purchase pattern', { exact: true });
  const before = await mode.inputValue();
  if (before !== 'weighted_split') await mode.selectOption('weighted_split');
  await act();
  if (before !== 'weighted_split') await mode.selectOption(before);
}

export async function fillBoundsDraft(editor: Locator, name: string) {
  await revealed(editor, async () => {
    for (const [key, value] of Object.entries(boundsDraft(name))) {
      await onItsPage(editor, key);
      await field(editor, key).fill(String(value));
    }
  });
}

export async function expectBoundsDraft(editor: Locator, name: string) {
  await revealed(editor, async () => {
    for (const [key, value] of Object.entries(boundsDraft(name))) {
      await onItsPage(editor, key);
      await expect(field(editor, key)).toHaveValue(String(value));
    }
  });
}
