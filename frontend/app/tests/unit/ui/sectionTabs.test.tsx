import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { copy } from '../../../src/copy/catalogue.ts';
import { SectionPanel, SectionTabs } from '../../../src/ui/SectionTabs.tsx';

// Catalogue text only.
const ROW = copy.runs.sections.short;
const A = copy.routes.dashboard.short;
const B = copy.routes.runs.short;
const SECTIONS = [
  { key: 'a', label: A },
  { key: 'b', label: B },
] as const;

function Demo({ invalidInB = false }: { readonly invalidInB?: boolean }) {
  const [current, setCurrent] = useState<'a' | 'b'>('a');
  return (
    <>
      <SectionTabs
        label={ROW}
        idPrefix="demo"
        sections={SECTIONS}
        current={current}
        onSelect={setCurrent}
      />
      <SectionPanel idPrefix="demo" section="a" current={current}>
        <input aria-label={A} />
      </SectionPanel>
      <SectionPanel idPrefix="demo" section="b" current={current}>
        <input aria-label={B} aria-invalid={invalidInB || undefined} />
      </SectionPanel>
    </>
  );
}

describe('SectionTabs', () => {
  it('shows one section at a time, its button pressed, every panel still mounted', async () => {
    const { container } = render(<Demo />);
    const row = screen.getByRole('navigation', { name: ROW });
    const first = screen.getByRole('button', { name: A });
    const second = screen.getByRole('button', { name: B });
    expect(row).toContainElement(first);
    expect(first).toHaveAttribute('aria-pressed', 'true');
    expect(first).toHaveAttribute('aria-controls', 'demo-a');
    expect(second).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('textbox', { name: A })).toBeVisible();
    // Hidden, not removed: drafts, timers and focus targets in it keep working.
    expect(container.querySelector('#demo-b')).toHaveAttribute('hidden');
    expect(screen.queryByRole('textbox', { name: B })).toBeNull();

    await userEvent.click(second);
    expect(second).toHaveAttribute('aria-pressed', 'true');
    expect(first).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelector('#demo-a')).toHaveAttribute('hidden');
    expect(screen.getByRole('textbox', { name: B })).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('names a hidden section holding an invalid field on its button, and follows the field', async () => {
    const { rerender } = render(<Demo invalidInB />);
    const second = screen.getByRole('button', { name: /^Runs/u });
    expect(second).toHaveTextContent(copy.runs.needsAttention.short);
    expect(screen.getByRole('button', { name: A })).not.toHaveTextContent(
      copy.runs.needsAttention.short,
    );
    // The field becomes valid: the mark goes.
    rerender(<Demo />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: B })).not.toHaveTextContent(
      copy.runs.needsAttention.short,
    );
  });
});
