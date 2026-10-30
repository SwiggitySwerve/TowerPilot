import { useState } from 'react';
import { copy } from '../../copy/catalogue.ts';
import { gallery as g } from '../../copy/gallery.ts';
import type { CopyEntry, CopyNode } from '../../copy/text.ts';
import { Reason } from '../../ui/ActionRow.tsx';
import { Button } from '../../ui/Button.tsx';
import { ChipField } from '../../ui/ChipField.tsx';
import { ChipGrid } from '../../ui/ChipGrid.tsx';
import { CompactField } from '../../ui/CompactField.tsx';
import { MarkChip, MarkLegend } from '../../ui/MarkChip.tsx';
import { KindTag } from '../../ui/Pill.tsx';
import { PriorityQueue } from '../../ui/PriorityQueue.tsx';
import { RecordRow } from '../../ui/RecordRow.tsx';
import { Region, RegionBody } from '../../ui/Region.tsx';
import { ShownList } from '../../ui/ShownList.tsx';
import { StatusDot } from '../../ui/StatusDot.tsx';
import { Tile } from '../../ui/Tile.tsx';
import { ToggleChip, type ItemTone } from '../../ui/ToggleChip.tsx';
import './gallery.css';

const TONES: readonly ItemTone[] = ['attack', 'defense', 'utility', 'neutral'];

function toneOf(index: number): ItemTone {
  return TONES[index % TONES.length] ?? 'neutral';
}

function numbers(count: number): number[] {
  return Array.from({ length: count }, (_unused, index) => index + 1);
}

/** A grid of `count` toggle chips with their own pressed state and a tap limit when on. */
function DemoGrid({ label, count }: { readonly label: CopyEntry; readonly count: number }) {
  const [on, setOn] = useState<ReadonlySet<number>>(new Set([2, 3]));
  const [limits, setLimits] = useState<Readonly<Record<number, string>>>({});
  return (
    <ChipGrid label={label.short}>
      {numbers(count).map((n) => (
        <ToggleChip
          key={n}
          tone={toneOf(n - 1)}
          label={g.itemName(n)}
          pressed={on.has(n)}
          onToggle={(next) => {
            setOn((previous) => {
              const copied = new Set(previous);
              if (next) copied.add(n);
              else copied.delete(n);
              return copied;
            });
          }}
          controls={(nameId) => (
            <ChipField
              label={g.fields.tapLimit.short}
              itemId={nameId}
              value={limits[n] ?? ''}
              placeholder={g.fields.unlimited.short}
              min={0}
              onChange={(value) => {
                setLimits((previous) => ({ ...previous, [n]: value }));
              }}
            />
          )}
        />
      ))}
    </ChipGrid>
  );
}

function States() {
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  const [limit, setLimit] = useState('5');
  const [weight, setWeight] = useState('1');
  const [invalidLimit, setInvalidLimit] = useState('-3');
  return (
    <>
      <ChipGrid label={g.sections.states.short}>
        <ToggleChip tone="attack" label={g.states.off.short} pressed={off} onToggle={setOff} />
        <ToggleChip
          tone="defense"
          label={g.states.on.short}
          pressed={on}
          onToggle={setOn}
          controls={(nameId) => (
            <>
              <ChipField
                label={g.fields.tapLimit.short}
                itemId={nameId}
                value={limit}
                placeholder={g.fields.unlimited.short}
                min={0}
                onChange={setLimit}
              />
              <ChipField
                label={g.fields.perTurn.short}
                itemId={nameId}
                value={weight}
                min={1}
                max={100}
                onChange={setWeight}
              />
            </>
          )}
        />
        <ToggleChip
          tone="utility"
          label={g.states.disabled.short}
          pressed={false}
          onToggle={() => undefined}
          disabled
          reasonId="gallery-disabled-reason"
        />
        <ToggleChip
          tone="neutral"
          label={g.states.unsupported.short}
          pressed={false}
          onToggle={() => undefined}
          unsupported
        />
        <ToggleChip
          tone="attack"
          label={g.states.invalid.short}
          pressed
          onToggle={() => undefined}
          invalidReasonId="gallery-invalid-reason"
          controls={(nameId) => (
            <ChipField
              label={g.fields.tapLimit.short}
              itemId={nameId}
              value={invalidLimit}
              min={0}
              invalid
              errorId="gallery-invalid-reason"
              onChange={setInvalidLimit}
            />
          )}
        />
        <ToggleChip
          tone="defense"
          label={g.states.long.short}
          pressed={false}
          onToggle={() => undefined}
        />
      </ChipGrid>
      <Reason id="gallery-disabled-reason" entry={g.states.disabledReason} />
      <p id="gallery-invalid-reason" className="tp-reason">
        {g.states.invalidReason.short}
      </p>
    </>
  );
}

function Marked() {
  return (
    <>
      <ChipGrid label={g.grids.marked.short} size="cell">
        <MarkChip label={g.itemName(1)} active mastered />
        <MarkChip label={g.itemName(2)} active />
        <MarkChip label={g.itemName(3)} mastered />
        <MarkChip label={g.itemName(4)} />
        <MarkChip label={g.states.long.short} active mastered />
        <MarkChip label={g.itemName(6)} active />
      </ChipGrid>
      <MarkLegend active mastered />
    </>
  );
}

function Queue() {
  const [queue, setQueue] = useState<readonly number[]>([3, 1, 2]);
  return (
    <div className="tp-gallery__split">
      <PriorityQueue
        label={g.queue.label.short}
        items={queue.map((n) => ({ id: String(n), label: g.itemName(n), tone: toneOf(n - 1) }))}
        onMove={(id, toIndex) => {
          setQueue((previous) => {
            const rest = previous.filter((n) => String(n) !== id);
            return [...rest.slice(0, toIndex), Number(id), ...rest.slice(toIndex)];
          });
        }}
        onAdd={(id) => {
          setQueue((previous) => [...previous, Number(id)]);
        }}
      />
      <ChipGrid label={g.queue.sources.short}>
        {numbers(6).map((n) => (
          <ToggleChip
            key={n}
            tone={toneOf(n - 1)}
            label={g.itemName(n)}
            pressed={queue.includes(n)}
            dragId={String(n)}
            onToggle={(next) => {
              setQueue((previous) =>
                next ? [...previous, n] : previous.filter((value) => value !== n),
              );
            }}
          />
        ))}
      </ChipGrid>
    </div>
  );
}

function Density() {
  return (
    <div className="tp-gallery__stack">
      <RecordRow
        name={g.recordName(1)}
        kind={<KindTag label={g.density.kind.short} />}
        summary={g.density.summary.short}
        usedBy={[g.recordName(2), g.recordName(3)]}
        actions={
          <>
            <Button tier="secondary" label={g.density.edit.short} onClick={() => undefined} />
            <Button tier="quiet" label={g.density.copy.short} onClick={() => undefined} />
          </>
        }
      />
      <RecordRow
        name={g.recordName(4)}
        kind={<KindTag label={g.density.kind.short} tone="ok" />}
        summary={g.states.long.short}
      />
      <RecordRow name={g.recordName(5)} />
      <p className="tp-gallery__row">
        <span>{g.density.dots.short}</span>
        <StatusDot tone="ok" />
        <StatusDot tone="warn" />
        <StatusDot tone="bad" />
        <StatusDot tone="unknown" />
      </p>
    </div>
  );
}

function Fields() {
  const [name, setName] = useState('');
  const [count, setCount] = useState('4');
  return (
    <div className="tp-gallery__row">
      <CompactField label={g.fields.name.short} value={name} onSave={setName} />
      <CompactField label={g.fields.count.short} type="number" value={count} onSave={setCount} />
      <CompactField label={g.fields.savePending.short} value="7" onSave={() => undefined} pending />
      <CompactField
        label={g.fields.saveError.short}
        value="7"
        onSave={() => undefined}
        error={g.fields.saveFailed.short}
      />
    </div>
  );
}

function Shown() {
  const records = numbers(24);
  return (
    <div className="tp-gallery__stack">
      <Tile titleId="gallery-shown-all" title={g.shown.all.short} density="compact">
        <ShownList
          items={records}
          itemKey={String}
          render={(n) => <RecordRow name={g.recordName(n)} />}
          limit="all"
          layout="grid"
        />
      </Tile>
      <Tile titleId="gallery-shown-folded" title={g.shown.folded.short} density="compact">
        <ShownList
          items={records}
          itemKey={String}
          render={(n) => <RecordRow name={g.recordName(n)} />}
          more={g.shown.more.short}
        />
      </Tile>
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: CopyEntry;
  readonly children: CopyNode;
}) {
  return (
    <Region id={id} title={title.short} fallback={copy.errors.regionFailed.short}>
      <RegionBody>{children}</RegionBody>
    </Region>
  );
}

/**
 * The item gallery (`#gallery`): every item primitive in every state, with made-up names.
 * It is reachable by address only; the navigation does not list it.
 */
export function GalleryPage() {
  return (
    <>
      <header className="tp-topbar">
        <h1 className="tp-topbar__page">{g.pageName.short}</h1>
      </header>
      <main id="main" className="tp-main tp-gallery" tabIndex={-1}>
        <p>{g.intro.short}</p>
        <Section id="galleryStates" title={g.sections.states}>
          <States />
        </Section>
        <Section id="gallerySizes" title={g.sections.sizes}>
          <div className="tp-gallery__stack">
            <DemoGrid label={g.grids.three} count={3} />
            <DemoGrid label={g.grids.twelve} count={12} />
            <DemoGrid label={g.grids.fortyEight} count={48} />
          </div>
        </Section>
        <Section id="galleryNarrow" title={g.sections.narrow}>
          <div className="tp-gallery__narrow" data-gallery="narrow">
            <DemoGrid label={g.grids.three} count={4} />
          </div>
        </Section>
        <Section id="galleryMarks" title={g.sections.marks}>
          <Marked />
        </Section>
        <Section id="galleryQueue" title={g.sections.queue}>
          <Queue />
        </Section>
        <Section id="galleryDensity" title={g.sections.density}>
          <Density />
        </Section>
        <Section id="galleryFields" title={g.sections.fields}>
          <Fields />
        </Section>
        <Section id="galleryShown" title={g.sections.shown}>
          <Shown />
        </Section>
      </main>
    </>
  );
}
