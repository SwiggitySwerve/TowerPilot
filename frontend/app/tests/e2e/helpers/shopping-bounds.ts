import { expect, type Locator } from '@playwright/test';
import { own } from '../../../src/core/read.ts';
import { shopCatalog } from '../../../src/core/shoppingPlan.ts';
import { dashboardPagesCase } from '../../support/dashboardFixture.ts';
import { boundsDraft } from '../../support/shoppingBounds.ts';

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

/** The wave ranges fold away and the weight shows only in Weighted split: open both for `act`. */
async function revealed(editor: Locator, act: () => Promise<void>) {
  await editor.locator('details:not(:has(details)):has(.tp-shop__waves)').evaluate((element) => {
    if (element instanceof HTMLDetailsElement) element.open = true;
  });
  const mode = editor.getByLabel('Purchase pattern', { exact: true });
  const before = await mode.inputValue();
  if (before !== 'weighted_split') await mode.selectOption('weighted_split');
  await act();
  if (before !== 'weighted_split') await mode.selectOption(before);
}

export async function fillBoundsDraft(editor: Locator, name: string) {
  await revealed(editor, async () => {
    for (const [key, value] of Object.entries(boundsDraft(name)))
      await field(editor, key).fill(String(value));
  });
}

export async function expectBoundsDraft(editor: Locator, name: string) {
  await revealed(editor, async () => {
    for (const [key, value] of Object.entries(boundsDraft(name)))
      await expect(field(editor, key)).toHaveValue(String(value));
  });
}
