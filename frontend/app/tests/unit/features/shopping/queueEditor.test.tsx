import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { own, ownPath } from '../../../../src/core/read.ts';
import {
  includeUpgrade,
  leaveOutUpgrade,
  moveUpgradeTo,
  queuePlan,
  reviewQueue,
  setExcluded,
  shopCatalog,
  type QueueBase,
  type QueueDraft,
} from '../../../../src/core/shoppingPlan.ts';
import { QueueEditor } from '../../../../src/features/shopping/QueueEditor.tsx';
import { selectQueueEditor } from '../../../../src/store/selectors/shoppingQueue.ts';
import { initialDashboardState } from '../../../../src/store/dashboardStore.ts';
import { textOutsideCatalogue } from '../../copy/renderedText.ts';
import { dashboardPagesCase } from '../../../support/dashboardFixture.ts';
import { renderRegion } from '../dashboard/harness.tsx';

const read = dashboardPagesCase('shopping_queue.shopping_read_before_any_save').body;
const BASE: QueueBase = {
  plan: queuePlan(ownPath(read, 'settings', 'shopping_plan')),
  catalog: shopCatalog(own(read, 'catalog')),
};

let latest: QueueDraft = {};
function Harness({ initial = {} }: { readonly initial?: QueueDraft }) {
  const [draft, setDraft] = useState<QueueDraft>(initial);
  latest = draft;
  return (
    <QueueEditor
      vm={selectQueueEditor(BASE, draft)}
      idBase="test"
      onEdit={(key, value) => {
        setDraft((current) => ({ ...current, [key]: value }));
      }}
      onInclude={(upgrade) => {
        setDraft((current) => includeUpgrade(BASE, current, upgrade));
      }}
      onLeaveOut={(upgrade) => {
        setDraft((current) => leaveOutUpgrade(current, upgrade));
      }}
      onMove={(upgrade, to) => {
        const next = moveUpgradeTo(BASE, latest, upgrade, to);
        if (next !== null) setDraft(next);
      }}
      onExclude={(upgrade, excluded) => {
        setDraft((current) => setExcluded(current, upgrade, excluded));
      }}
    />
  );
}
/** The names in the priority queue, in order. */
const queued = () =>
  [...document.querySelectorAll('.tp-queue__item .tp-queue__name')].map((item) => item.textContent);
const page = (name: string) => within(screen.getByRole('list', { name, hidden: true }));
/** A chip by its name; a never-buy upgrade's mark adds its name to the button's name. */
const chip = (grid: string, name: string) =>
  page(grid).getByRole('button', {
    name: new RegExp(`^${name}(Never buy|Needs attention)*$`, 'u'),
  });

describe('F6-12 shared queue editor (recorded shopping_read_before_any_save)', () => {
  it('SQ6 named Up/Down keep focus on the moved entry, announce its position and stop at the ends', async () => {
    renderRegion(
      initialDashboardState(),
      <main>
        <Harness />
      </main>,
    );
    const user = userEvent.setup();
    expect(queued()).toEqual(['Damage', 'Health']);
    const down = () => screen.getByRole('button', { name: /Move down.*Damage/u });
    down().focus();
    await user.keyboard('{Enter}');
    expect(queued()).toEqual(['Health', 'Damage']);
    expect(document.activeElement).toBe(down());
    expect(screen.getByRole('status')).toHaveTextContent('Moved to position 2 of 2');
    // Now last: Move down is unavailable and does nothing.
    expect(down()).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Enter}');
    expect(queued()).toEqual(['Health', 'Damage']);
  });

  it('SQ4 SQ5 chips put one queue across pages, keep limits when left out, and typed text stays', () => {
    renderRegion(
      initialDashboardState(),
      <main>
        <Harness initial={{ 'entry:damage:tap_limit': '1.5e' }} />
      </main>,
    );
    // Every chip of every page is on the page; only the selected ones carry fields.
    expect(page('Attack').getAllByRole('button')).toHaveLength(17);
    const tap = screen.getByRole('spinbutton', { name: 'Tap attempts this battle: Damage' });
    expect(tap).toHaveValue(null);
    expect(tap).toHaveAttribute('aria-invalid', 'true');
    expect(tap).toHaveAccessibleDescription(/Damage Tap attempts this battle Not a number/u);
    expect(screen.getAllByRole('spinbutton', { name: /Tap attempts this battle/u })).toHaveLength(
      2,
    );
    fireEvent.click(chip('Attack', 'Attack Speed'));
    expect(queued()).toEqual(['Damage', 'Health', 'Attack Speed']);
    expect(chip('Attack', 'Attack Speed')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'Tap attempts this battle: Attack Speed' }),
      { target: { value: '4' } },
    );
    expect(reviewQueue(BASE, latest).entries.at(-1)?.fields.tap_limit.raw).toBe('4');
    // The teaching clause lives in the help, opened on demand and not in the page.
    expect(screen.queryByText(/Counts taps sent, not levels bought/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /About Selected upgrades show/u }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('The tap limit counts taps sent');
    fireEvent.click(chip('Attack', 'Damage'));
    expect(queued()).toEqual(['Health', 'Attack Speed']);
    expect(
      screen.queryByRole('spinbutton', { name: 'Tap attempts this battle: Damage' }),
    ).toBeNull();
    expect(latest['entry:damage:tap_limit']).toBe('1.5e');
    expect(screen.getByText('1 field needs a value before this queue can be sent.')).toBeVisible();
    fireEvent.click(chip('Attack', 'Damage'));
    expect(
      screen.getByRole('spinbutton', { name: 'Tap attempts this battle: Damage' }),
    ).toHaveAttribute('aria-invalid', 'true');
  });

  it('SQ4 Defense Absolute starts excluded with its reason; including it removes the exclusion', () => {
    renderRegion(
      initialDashboardState(),
      <main>
        <Harness />
      </main>,
    );
    const never = page('Never buy');
    expect(never.getByRole('button', { name: 'Defense Absolute' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      within(chip('Defense', 'Defense Absolute')).getByRole('img', { name: 'Never buy' }),
    ).toBeVisible();
    expect(chip('Defense', 'Defense Absolute')).toHaveAccessibleDescription(
      /Excluded by default: /u,
    );
    fireEvent.click(chip('Defense', 'Defense Absolute'));
    expect(never.getByRole('button', { name: 'Defense Absolute' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(queued().at(-1)).toBe('Defense Absolute');
    fireEvent.click(never.getByRole('button', { name: 'Defense Absolute' }));
    expect(queued().at(-1)).not.toBe('Defense Absolute');
  });

  it('SQ4 a wave range is edited beside its upgrade and a drag moves any distance', () => {
    renderRegion(
      initialDashboardState(),
      <main>
        <Harness />
      </main>,
    );
    const from = screen.getByRole('spinbutton', { name: 'From wave: Health' });
    fireEvent.change(from, { target: { value: '5' } });
    expect(
      reviewQueue(BASE, latest).entries.find((e) => e.id === 'health')?.fields.from_wave.raw,
    ).toBe('5');
    fireEvent.click(chip('Attack', 'Attack Speed'));
    fireEvent.click(chip('Attack', 'Range'));
    const drag = moveUpgradeTo(BASE, latest, 'range', 0);
    expect(drag).not.toBeNull();
    expect(queued()).toEqual(['Damage', 'Health', 'Attack Speed', 'Range']);
  });

  it('SQ3 the purchase rules use catalogue words; reserve 0 is a value', async () => {
    renderRegion(
      initialDashboardState(),
      <main>
        <Harness />
      </main>,
    );
    const reserve = document.getElementById('test:reserve');
    if (!(reserve instanceof HTMLInputElement)) throw new Error('no reserve');
    expect(reserve).toHaveValue('500');
    await act(async () => {
      fireEvent.change(reserve, { target: { value: '0' } });
      await Promise.resolve();
    });
    expect(reviewQueue(BASE, latest).plan).toMatchObject({ cash_reserve: 0 });
    expect(screen.getByRole('combobox', { name: 'Purchase pattern' })).toHaveDisplayValue(
      'First affordable in priority order',
    );
    expect(textOutsideCatalogue(document.body)).toEqual([]);
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
