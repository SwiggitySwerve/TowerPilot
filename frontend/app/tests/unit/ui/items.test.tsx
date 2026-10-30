import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { copy } from '../../../src/copy/catalogue.ts';
import { gallery as g } from '../../../src/copy/gallery.ts';
import { ChipField } from '../../../src/ui/ChipField.tsx';
import { ChipGrid } from '../../../src/ui/ChipGrid.tsx';
import { CompactField } from '../../../src/ui/CompactField.tsx';
import { LiveRegionProvider } from '../../../src/ui/LiveRegion.tsx';
import { MarkChip, MarkLegend } from '../../../src/ui/MarkChip.tsx';
import { KindTag } from '../../../src/ui/Pill.tsx';
import { PriorityQueue } from '../../../src/ui/PriorityQueue.tsx';
import { RecordRow } from '../../../src/ui/RecordRow.tsx';
import { ShownList } from '../../../src/ui/ShownList.tsx';
import { StatusDot } from '../../../src/ui/StatusDot.tsx';
import { ToggleChip } from '../../../src/ui/ToggleChip.tsx';
import { textOutsideCatalogue } from '../copy/renderedText.ts';

const NAME = g.itemName(1);
const noop = () => undefined;

/** A minimal DataTransfer: enough for the item drag payload, shared across one gesture. */
function transfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: '',
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    get types() {
      return [...data.keys()];
    },
  };
}

function Toggle({ withControls = true }: { readonly withControls?: boolean }) {
  const [on, setOn] = useState(false);
  return (
    <ChipGrid label={g.sections.states.short}>
      <ToggleChip
        tone="attack"
        label={NAME}
        pressed={on}
        onToggle={setOn}
        {...(withControls
          ? {
              controls: (nameId: string) => (
                <ChipField
                  label={g.fields.tapLimit.short}
                  itemId={nameId}
                  value=""
                  onChange={noop}
                />
              ),
            }
          : {})}
      />
    </ChipGrid>
  );
}

describe('ToggleChip', () => {
  it('toggles by click, Space and Enter, and its label never changes', async () => {
    const user = userEvent.setup();
    const { container } = render(<Toggle />);
    const button = screen.getByRole('button', { name: NAME });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await user.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    button.focus();
    await user.keyboard(' ');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: NAME })).toBe(button);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows its controls only while pressed, as siblings of the button, never inside it', async () => {
    const user = userEvent.setup();
    const { container } = render(<Toggle />);
    expect(screen.queryByRole('spinbutton')).toBeNull();
    await user.click(screen.getByRole('button', { name: NAME }));
    const field = screen.getByRole('spinbutton', { name: `${g.fields.tapLimit.short}: ${NAME}` });
    const button = screen.getByRole('button', { name: NAME });
    expect(button.contains(field)).toBe(false);
    expect(button.parentElement).toBe(field.closest('li'));
    expect(await axe(container)).toHaveNoViolations();
    await user.click(button);
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('stays focusable and does nothing while disabled, and names its visible reason', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { container } = render(
      <>
        <ChipGrid label={g.sections.states.short}>
          <ToggleChip
            tone="utility"
            label={NAME}
            pressed={false}
            onToggle={onToggle}
            disabled
            reasonId="why"
          />
        </ChipGrid>
        <span id="why">{g.states.disabledReason.short}</span>
      </>,
    );
    const button = screen.getByRole('button', { name: NAME });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(g.states.disabledReason.short);
    await user.click(button);
    button.focus();
    await user.keyboard('{Enter}');
    expect(onToggle).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('marks an unsupported item in text and refuses to switch it on', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { container } = render(
      <ChipGrid label={g.sections.states.short}>
        <ToggleChip tone="neutral" label={NAME} pressed={false} onToggle={onToggle} unsupported />
      </ChipGrid>,
    );
    expect(
      screen.getByRole('img', { name: copy.items.marks.unsupported.short }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: new RegExp(NAME) }));
    expect(onToggle).not.toHaveBeenCalled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('draws an invalid edge with a mark and a described reason, not colour alone', async () => {
    const { container } = render(
      <>
        <ChipGrid label={g.sections.states.short}>
          <ToggleChip tone="attack" label={NAME} pressed onToggle={noop} invalidReasonId="bad" />
        </ChipGrid>
        <p id="bad">{g.states.invalidReason.short}</p>
      </>,
    );
    expect(container.querySelector('li')).toHaveAttribute('data-invalid', 'true');
    expect(screen.getByRole('img', { name: copy.items.marks.invalid.short })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(NAME) })).toHaveAccessibleDescription(
      g.states.invalidReason.short,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('ChipGrid', () => {
  it('renders every one of 48 items, folds nothing and adds no roving tabindex', async () => {
    const { container } = render(
      <ChipGrid label={g.grids.fortyEight.short}>
        {Array.from({ length: 48 }, (_unused, index) => (
          <ToggleChip
            key={index}
            tone="defense"
            label={g.itemName(index + 1)}
            pressed={false}
            onToggle={noop}
          />
        ))}
      </ChipGrid>,
    );
    const list = screen.getByRole('list', { name: g.grids.fortyEight.short });
    expect(within(list).getAllByRole('listitem')).toHaveLength(48);
    expect(screen.getAllByRole('button')).toHaveLength(48);
    expect(container.querySelector('[tabindex]')).toBeNull();
    expect(container.querySelector('details')).toBeNull();
    expect(textOutsideCatalogue(container)).toEqual([]);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('visits every chip with Tab', async () => {
    const user = userEvent.setup();
    render(
      <ChipGrid label={g.grids.three.short}>
        {[1, 2, 3].map((n) => (
          <ToggleChip
            key={n}
            tone="utility"
            label={g.itemName(n)}
            pressed={false}
            onToggle={noop}
          />
        ))}
      </ChipGrid>,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: g.itemName(1) })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: g.itemName(2) })).toHaveFocus();
  });
});

describe('MarkChip and MarkLegend', () => {
  it('shows the check first and the star second, each as a named image', async () => {
    const { container } = render(
      <ChipGrid label={g.grids.marked.short} size="cell">
        <MarkChip label={NAME} active mastered />
        <MarkChip label={g.itemName(2)} />
      </ChipGrid>,
    );
    const first = screen.getAllByRole('listitem')[0];
    expect(first).toBeDefined();
    const marks = within(first as HTMLElement).getAllByRole('img');
    expect(marks.map((mark) => mark.getAttribute('aria-label'))).toEqual([
      copy.items.marks.active.short,
      copy.items.marks.mastered.short,
    ]);
    expect(first).toHaveAttribute('data-on', 'true');
    expect(within(screen.getAllByRole('listitem')[1] as HTMLElement).queryByRole('img')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('draws the legend only for marks that are present', () => {
    const none = render(<MarkLegend active={false} mastered={false} />);
    expect(none.container).toBeEmptyDOMElement();
    none.unmount();
    render(<MarkLegend active mastered={false} />);
    const legend = screen.getByRole('list', { name: copy.items.legend.short });
    expect(within(legend).getByText(copy.items.marks.active.short)).toBeInTheDocument();
    expect(within(legend).queryByText(copy.items.marks.mastered.short)).toBeNull();
  });
});

function Queue({
  onMove,
  onAdd,
}: {
  onMove?: (id: string, to: number) => void;
  onAdd?: (id: string) => void;
}) {
  const [order, setOrder] = useState(['a', 'b', 'c']);
  return (
    <LiveRegionProvider>
      <PriorityQueue
        label={g.queue.label.short}
        items={order.map((id) => ({ id, label: g.itemName('abc'.indexOf(id) + 1) }))}
        onMove={(id, to) => {
          onMove?.(id, to);
          setOrder((previous) => {
            const rest = previous.filter((value) => value !== id);
            return [...rest.slice(0, to), id, ...rest.slice(to)];
          });
        }}
        {...(onAdd === undefined ? {} : { onAdd })}
      />
      <ChipGrid label={g.queue.sources.short}>
        <ToggleChip
          tone="attack"
          label={g.itemName(9)}
          pressed={false}
          onToggle={noop}
          dragId="x"
        />
      </ChipGrid>
    </LiveRegionProvider>
  );
}

function names() {
  return within(screen.getByRole('list', { name: g.queue.label.short }))
    .getAllByRole('listitem')
    .filter((item) => item.getAttribute('aria-hidden') !== 'true')
    .map((item) => item.querySelector('.tp-queue__name')?.textContent);
}

describe('PriorityQueue', () => {
  it('moves an entry with the buttons, keeps focus on the same button and announces the position', async () => {
    const user = userEvent.setup();
    const { container } = render(<Queue />);
    expect(names()).toEqual([g.itemName(1), g.itemName(2), g.itemName(3)]);
    const down = screen.getByRole('button', {
      name: `${copy.items.queue.moveDown.short} ${g.itemName(1)}`,
    });
    await user.click(down);
    expect(names()).toEqual([g.itemName(2), g.itemName(1), g.itemName(3)]);
    expect(down).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent(copy.items.queue.moved(2, 3));
    const up = screen.getByRole('button', {
      name: `${copy.items.queue.moveUp.short} ${g.itemName(1)}`,
    });
    await user.click(up);
    await user.click(up);
    expect(names()).toEqual([g.itemName(1), g.itemName(2), g.itemName(3)]);
    expect(up).toHaveFocus();
    expect(up).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(copy.items.queue.moved(1, 3));
    expect(await axe(container)).toHaveNoViolations();
  });

  it('cannot move the first entry up or the last down', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    render(<Queue onMove={onMove} />);
    await user.click(
      screen.getByRole('button', { name: `${copy.items.queue.moveUp.short} ${g.itemName(1)}` }),
    );
    await user.click(
      screen.getByRole('button', { name: `${copy.items.queue.moveDown.short} ${g.itemName(3)}` }),
    );
    expect(onMove).not.toHaveBeenCalled();
  });

  it('reorders by drag and drop: onto an entry, and onto the end slot', () => {
    const onMove = vi.fn();
    render(<Queue onMove={onMove} />);
    const entries = () =>
      screen.getAllByRole('listitem').filter((li) => li.classList.contains('tp-queue__item'));
    const dataTransfer = transfer();
    fireEvent.dragStart(entries()[0] as HTMLElement, { dataTransfer });
    fireEvent.dragOver(entries()[2] as HTMLElement, { dataTransfer });
    expect(entries()[2]).toHaveAttribute('data-drop-target', 'true');
    fireEvent.drop(entries()[2] as HTMLElement, { dataTransfer });
    expect(onMove).toHaveBeenLastCalledWith('a', 2);
    expect(names()).toEqual([g.itemName(2), g.itemName(3), g.itemName(1)]);

    const second = transfer();
    fireEvent.dragStart(entries()[0] as HTMLElement, { dataTransfer: second });
    const end = document.querySelector('.tp-queue__end') as HTMLElement;
    fireEvent.dragOver(end, { dataTransfer: second });
    fireEvent.drop(end, { dataTransfer: second });
    expect(onMove).toHaveBeenLastCalledWith('b', 2);
  });

  it('adds an item dragged in from outside at the end, and ignores other drags', () => {
    const onAdd = vi.fn();
    const onMove = vi.fn();
    render(<Queue onAdd={onAdd} onMove={onMove} />);
    const chip = screen.getByRole('button', { name: g.itemName(9) }).closest('li') as HTMLElement;
    expect(chip).toHaveAttribute('draggable', 'true');
    const dataTransfer = transfer();
    fireEvent.dragStart(chip, { dataTransfer });
    const end = document.querySelector('.tp-queue__end') as HTMLElement;
    fireEvent.dragOver(end, { dataTransfer });
    fireEvent.drop(end, { dataTransfer });
    expect(onAdd).toHaveBeenCalledWith('x');

    const text = transfer();
    text.setData('text/plain', 'a');
    fireEvent.drop(end, { dataTransfer: text });
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onMove).not.toHaveBeenCalled();
  });
});

describe('density family', () => {
  it('RecordRow draws name, tag, summary, who uses it and its actions in one line', async () => {
    const { container } = render(
      <RecordRow
        name={g.recordName(1)}
        kind={<KindTag label={g.density.kind.short} tone="ok" />}
        summary={g.density.summary.short}
        usedBy={[g.recordName(2), g.recordName(3)]}
        actions={<button type="button">{g.density.edit.short}</button>}
      />,
    );
    const row = container.querySelector('.tp-record-row') as HTMLElement;
    expect(row.textContent).toContain(g.recordName(1));
    expect(row.textContent).toContain(
      `${copy.items.record.usedBy.short}${g.recordName(2)}${copy.items.record.separator.short}${g.recordName(3)}`,
    );
    expect(within(row).getByRole('button', { name: g.density.edit.short })).toBeInTheDocument();
    expect(container.querySelector('.tp-pill')).toHaveAttribute('data-tone', 'ok');
    expect(textOutsideCatalogue(container)).toEqual([]);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('StatusDot has a text alternative for every tone and a distinct tone attribute', async () => {
    const { container } = render(
      <>
        <StatusDot tone="ok" />
        <StatusDot tone="warn" />
        <StatusDot tone="bad" />
        <StatusDot tone="unknown" />
      </>,
    );
    expect(screen.getAllByRole('img').map((dot) => dot.getAttribute('aria-label'))).toEqual([
      copy.items.dot.ok.short,
      copy.items.dot.warn.short,
      copy.items.dot.bad.short,
      copy.items.dot.unknown.short,
    ]);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('ShownList folds at 10 by default, shows everything with limit="all", and can be a grid', () => {
    const records = Array.from({ length: 24 }, (_unused, index) => index + 1);
    const folded = render(
      <ShownList
        items={records}
        itemKey={String}
        render={(n) => g.recordName(n)}
        more={g.shown.more.short}
      />,
    );
    expect(folded.container.querySelector('details')).not.toBeNull();
    expect(folded.container.querySelectorAll('.tp-shown')[0]?.children).toHaveLength(10);
    folded.unmount();
    const all = render(
      <ShownList
        items={records}
        itemKey={String}
        render={(n) => g.recordName(n)}
        limit="all"
        layout="grid"
      />,
    );
    expect(all.container.querySelector('details')).toBeNull();
    expect(all.container.querySelectorAll('li')).toHaveLength(24);
    expect(all.container.querySelector('.tp-shown--grid')).not.toBeNull();
  });
});

describe('CompactField', () => {
  function Field({
    onSave,
    error,
    pending,
  }: {
    onSave: (v: string) => void;
    error?: boolean;
    pending?: boolean;
  }) {
    return (
      <LiveRegionProvider>
        <CompactField
          label={g.fields.name.short}
          value="one"
          onSave={onSave}
          {...(pending === true ? { pending } : {})}
          {...(error === true ? { error: g.fields.saveFailed.short } : {})}
        />
      </LiveRegionProvider>
    );
  }

  it('saves on blur and on Enter, once, with no Save button', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { container } = render(<Field onSave={onSave} />);
    const input = screen.getByRole('textbox', { name: g.fields.name.short });
    expect(screen.queryByRole('button')).toBeNull();
    await user.clear(input);
    await user.type(input, 'two');
    await user.tab();
    expect(onSave).toHaveBeenCalledExactlyOnceWith('two');
    await user.clear(input);
    await user.type(input, 'three{Enter}');
    expect(onSave).toHaveBeenLastCalledWith('three');
    await user.tab();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('does not save an unchanged value and puts the saved value back on Escape', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<Field onSave={onSave} />);
    const input = screen.getByRole('textbox', { name: g.fields.name.short });
    await user.click(input);
    await user.tab();
    expect(onSave).not.toHaveBeenCalled();
    await user.type(input, 'x{Escape}');
    expect(input).toHaveValue('one');
  });

  it('is read-only while saving and says so, and shows a refusal beside the field', async () => {
    const pending = render(<Field onSave={noop} pending />);
    const input = screen.getByRole('textbox', { name: g.fields.name.short });
    expect(input).toHaveAttribute('readonly');
    expect(input).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(copy.items.compactField.saving.short)).toBeInTheDocument();
    expect(await axe(pending.container)).toHaveNoViolations();
    pending.unmount();
    const failed = render(<Field onSave={noop} error />);
    const field = screen.getByRole('textbox', { name: g.fields.name.short });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(g.fields.saveFailed.short);
    expect(await axe(failed.container)).toHaveNoViolations();
  });
});
