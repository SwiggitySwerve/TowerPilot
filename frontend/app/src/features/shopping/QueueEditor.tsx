import { copy } from '../../copy/catalogue.ts';
import type { CopyEntry, CopyNode, CopyText } from '../../copy/text.ts';
import { entryKey, type EntryField, type FieldReview } from '../../core/shoppingPlan.ts';
import type {
  ChoiceVM,
  EntryVM,
  PickerItemVM,
  PickerSectionVM,
  QueueEditorVM,
} from '../../store/selectors/shoppingQueue.ts';
import { ChipField } from '../../ui/ChipField.tsx';
import { ChipGrid } from '../../ui/ChipGrid.tsx';
import { Disclosure } from '../../ui/Disclosure.tsx';
import { HelpTip } from '../../ui/HelpTip.tsx';
import { Mark } from '../../ui/ItemGlyph.tsx';
import { PriorityQueue } from '../../ui/PriorityQueue.tsx';
import { ServerOption, ServerValue } from '../../ui/ServerValue.tsx';
import { Tile } from '../../ui/Tile.tsx';
import { ToggleChip, type ItemTone } from '../../ui/ToggleChip.tsx';
import './shopping.css';

const t = copy.shopping;

/** What the shared editor asks its owner to do with the draft (brief SQ3 to SQ6). */
export interface QueueEditorActions {
  readonly onEdit: (key: string, value: string | boolean) => void;
  readonly onInclude: (upgrade: string) => void;
  readonly onLeaveOut: (upgrade: string) => void;
  /** Move to zero-based place `to` of the whole queue (the place it holds after the move). */
  readonly onMove: (upgrade: string, to: number) => void;
  readonly onExclude: (upgrade: string, excluded: boolean) => void;
}

export interface QueueEditorProps extends QueueEditorActions {
  readonly vm: QueueEditorVM;
  /** Unique per editor on the page (saved run, live battle, library policy). */
  readonly idBase: string;
}

function Problem({ id, review }: { readonly id: string; readonly review: FieldReview }) {
  if (review.problem === null) return null;
  return (
    <span id={id} className="tp-shop__problem">
      {t.problems[review.problem].short}
    </span>
  );
}

/** Background for a numeric field: its own explanation, then its hint's. Nothing without either. */
function FieldHelp({ label, hint }: { readonly label: CopyEntry; readonly hint: CopyEntry }) {
  if (label.why === undefined && hint.why === undefined) return null;
  return (
    <HelpTip label={label.short}>
      {label.why === undefined ? null : <p>{label.why}</p>}
      {hint.why === undefined ? null : <p>{hint.why}</p>}
    </HelpTip>
  );
}

function NumberInput(props: {
  readonly id: string;
  readonly label: CopyEntry;
  readonly hint: CopyEntry;
  readonly review: FieldReview;
  readonly onChange: (value: string) => void;
}) {
  const { id, label, hint, review, onChange } = props;
  const invalid = review.problem !== null;
  const descriptionId = `${id}-hint`;
  return (
    <div className="tp-shop__field">
      <span className="tp-shop__label">
        <label htmlFor={id}>{label.short}</label>
        <FieldHelp label={label} hint={hint} />
      </span>
      <input
        id={id}
        className="tp-field-control"
        type="text"
        inputMode="decimal"
        value={review.raw}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-problem ${descriptionId}` : descriptionId}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
      <span id={descriptionId} className="tp-shop__hint">
        {hint.short}
      </span>
      <Problem id={`${id}-problem`} review={review} />
    </div>
  );
}

function Choice<K extends string>(props: {
  readonly id: string;
  readonly label: CopyEntry;
  readonly value: string;
  readonly problem: FieldReview['problem'];
  readonly choices: readonly ChoiceVM<K>[];
  readonly words: Readonly<Record<K, CopyEntry>>;
  readonly onChange: (value: string) => void;
}) {
  const { id, label, value, problem, choices, words, onChange } = props;
  const chosen = choices.find((choice) => choice.value === value);
  return (
    <div className="tp-shop__field">
      <span className="tp-shop__label">
        <label htmlFor={id}>{label.short}</label>
        <HelpTip label={label.short}>
          {choices.map((choice) => {
            if (choice.known === null) return null;
            const { short, why } = words[choice.known];
            return (
              <p key={choice.value}>
                <strong>{short}</strong>
                {why === undefined ? null : (
                  <>
                    {t.space}
                    {why}
                  </>
                )}
              </p>
            );
          })}
        </HelpTip>
      </span>
      <select
        id={id}
        className="tp-field-control"
        value={value}
        aria-invalid={problem !== null || undefined}
        aria-describedby={problem === null ? undefined : `${id}-problem`}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      >
        {value === '' ? <option value="">{t.choose.short}</option> : null}
        {choices.map((choice) =>
          choice.known !== null ? (
            <option key={choice.value} value={choice.value}>
              {words[choice.known].short}
            </option>
          ) : choice.server === null ? null : (
            <ServerOption key={choice.value} value={choice.value} label={choice.server} />
          ),
        )}
      </select>
      {problem === null ? null : (
        <span id={`${id}-problem`} className="tp-shop__problem">
          {t.problems[problem].short}
        </span>
      )}
      {chosen !== undefined && chosen.known === null ? (
        <span className="tp-shop__hint">{t.unknownChoice.short}</span>
      ) : null}
    </div>
  );
}

const FIELD_LABELS: Readonly<Record<EntryField, CopyEntry>> = {
  tap_limit: t.tapLimit,
  weight: t.weight,
  from_wave: t.fromWave,
  until_wave: t.untilWave,
};
const FIELD_ORDER: readonly EntryField[] = ['tap_limit', 'weight', 'from_wave', 'until_wave'];

const problemId = (idBase: string, upgrade: string, field: EntryField) =>
  `${idBase}:problem:${upgrade}:${field}`;

function nameOf(label: EntryVM['label']): CopyNode {
  return label === null ? null : <ServerValue kind="name" value={label} />;
}

function sectionTitle(section: PickerSectionVM): CopyNode {
  return section.known !== null ? (
    t.sections[section.known].short
  ) : section.server === null ? (
    t.otherSection.short
  ) : (
    <ServerValue kind="name" value={section.server} />
  );
}

/** The page's name for assistive technology; a page the server names itself reads as Other. */
const sectionLabel = (section: PickerSectionVM): CopyText =>
  section.known === null ? t.otherSection.short : t.sections[section.known].short;

const toneOf = (section: PickerSectionVM | undefined): ItemTone => section?.known ?? 'neutral';

interface Parts {
  readonly vm: QueueEditorVM;
  readonly idBase: string;
  readonly actions: QueueEditorActions;
}

/** One workshop page: a grid with every upgrade of the page as a chip, never folded. */
function Page({ section, vm, idBase, actions }: Parts & { readonly section: PickerSectionVM }) {
  const weighted = vm.mode.value === 'weighted_split';
  return (
    <Tile
      as="fieldset"
      className="tp-shop__page"
      titleId={`${idBase}:section:${section.key}`}
      title={sectionTitle(section)}
      density="compact"
    >
      <ChipGrid label={sectionLabel(section)}>
        {section.items.map((item) => {
          const entry = vm.entries.find((candidate) => candidate.id === item.id);
          const firstProblem =
            entry === undefined
              ? undefined
              : (['tap_limit', 'weight'] as const).find(
                  (field) => entry.fields[field].problem !== null,
                );
          return (
            <ToggleChip
              key={item.id}
              tone={toneOf(section)}
              label={nameOf(item.label)}
              pressed={item.included && !item.excluded}
              dragId={item.id}
              {...(item.excluded
                ? {
                    marks: <Mark kind="ban" label={t.excluded.short} />,
                    describedBy: `${idBase}:reason:${item.id}`,
                  }
                : {})}
              {...(firstProblem === undefined
                ? {}
                : { invalidReasonId: problemId(idBase, item.id, firstProblem) })}
              onToggle={(next) => {
                if (next) actions.onInclude(item.id);
                else actions.onLeaveOut(item.id);
              }}
              controls={(nameId) =>
                entry === undefined ? null : (
                  <>
                    <ChipField
                      label={t.tapLimit.short}
                      itemId={nameId}
                      value={entry.fields.tap_limit.raw}
                      placeholder={t.unlimited.short}
                      min={0}
                      invalid={entry.fields.tap_limit.problem !== null}
                      errorId={problemId(idBase, item.id, 'tap_limit')}
                      onChange={(value) => {
                        actions.onEdit(entryKey(item.id, 'tap_limit'), value);
                      }}
                    />
                    {weighted || entry.fields.weight.problem !== null ? (
                      <>
                        <span aria-hidden="true">{t.times.short}</span>
                        <ChipField
                          label={t.weight.short}
                          itemId={nameId}
                          value={entry.fields.weight.raw}
                          min={1}
                          max={100}
                          invalid={entry.fields.weight.problem !== null}
                          errorId={problemId(idBase, item.id, 'weight')}
                          onChange={(value) => {
                            actions.onEdit(entryKey(item.id, 'weight'), value);
                          }}
                        />
                      </>
                    ) : null}
                  </>
                )
              }
            />
          );
        })}
      </ChipGrid>
    </Tile>
  );
}

/** The never-buy list: the same upgrades, switched on to keep them out of every queue. */
function NeverBuy({ vm, idBase, actions }: Parts) {
  const items: readonly { readonly item: PickerItemVM; readonly tone: ItemTone }[] =
    vm.picker.flatMap((section) => section.items.map((item) => ({ item, tone: toneOf(section) })));
  const count = items.filter(({ item }) => item.excluded).length;
  return (
    <Disclosure label={t.excluded.short} count={count} focusKey={`${idBase}:never-buy`}>
      <ChipGrid label={t.excluded.short}>
        {items.map(({ item, tone }) => (
          <ToggleChip
            key={item.id}
            tone={tone}
            label={nameOf(item.label)}
            pressed={item.excluded}
            onToggle={(next) => {
              actions.onExclude(item.id, next);
            }}
          />
        ))}
      </ChipGrid>
    </Disclosure>
  );
}

/** The wave range of each upgrade of the plan: kept from the earlier editor, folded as few use it. */
function WaveRanges({ vm, idBase, actions }: Parts) {
  return (
    <Disclosure label={t.waveRanges.short} count={vm.entries.length} focusKey={`${idBase}:waves`}>
      <p className="tp-shop__hint">{t.waveRangesHint.short}</p>
      <ul className="tp-shop__waves">
        {vm.entries.map((entry) => (
          <li key={entry.id} className="tp-shop__wave" data-upgrade={entry.id}>
            <strong id={`${idBase}:wave:${entry.id}`}>{nameOf(entry.label)}</strong>
            {(['from_wave', 'until_wave'] as const).map((field) => (
              <span key={field} className="tp-shop__wave-field">
                <span aria-hidden="true">{FIELD_LABELS[field].short}</span>
                <ChipField
                  label={FIELD_LABELS[field].short}
                  itemId={`${idBase}:wave:${entry.id}`}
                  value={entry.fields[field].raw}
                  min={1}
                  invalid={entry.fields[field].problem !== null}
                  errorId={problemId(idBase, entry.id, field)}
                  onChange={(value) => {
                    actions.onEdit(entryKey(entry.id, field), value);
                  }}
                />
              </span>
            ))}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

/**
 * The one shopping queue editor (brief SQ3 to SQ6): purchase rules, the priority queue on the
 * left and the workshop pages as grids of chips beside it. Selecting a chip puts its upgrade in
 * the queue (a dragged chip lands there too); a selected chip carries its tap limit and, in
 * Weighted split, its weight. It renders a draft and reports edits; its owner keeps the draft,
 * the target and the Save row.
 */
export function QueueEditor(props: QueueEditorProps) {
  const { vm, idBase } = props;
  const review = vm.review;
  const parts: Parts = { vm, idBase, actions: props };
  const sections = new Map(
    vm.picker.flatMap((section) => section.items.map((item) => [item.id, section] as const)),
  );
  const excluded = new Set(
    vm.picker.flatMap((section) =>
      section.items.filter((item) => item.excluded).map((item) => item.id),
    ),
  );
  // The queue lists what will be bought; a left-out entry keeps its place in the plan, unseen.
  const queued = vm.entries.filter((entry) => entry.enabled && !excluded.has(entry.id));
  const reasons = vm.picker.flatMap((section) =>
    section.items.filter((item) => item.excluded && item.exclusionReason !== null),
  );
  const problems = vm.entries.flatMap((entry) =>
    FIELD_ORDER.flatMap((field) => {
      const problem = entry.fields[field].problem;
      return problem === null ? [] : [{ entry, field, problem }];
    }),
  );
  return (
    <div className="tp-shop">
      <Tile
        as="fieldset"
        className="tp-shop__rules"
        titleId={`${idBase}:rules`}
        title={t.rules.short}
      >
        <NumberInput
          id={`${idBase}:reserve`}
          label={t.reserve}
          hint={t.reserveHint}
          review={review.reserve}
          onChange={(value) => {
            props.onEdit('reserve', value);
          }}
        />
        <Choice
          id={`${idBase}:mode`}
          label={t.mode}
          value={vm.mode.value}
          problem={review.modeProblem}
          choices={vm.mode.choices}
          words={t.modes}
          onChange={(value) => {
            props.onEdit('mode', value);
          }}
        />
        <Choice
          id={`${idBase}:cadence`}
          label={t.cadence}
          value={vm.cadence.value}
          problem={review.cadenceProblem}
          choices={vm.cadence.choices}
          words={t.cadences}
          onChange={(value) => {
            props.onEdit('cadence', value);
          }}
        />
      </Tile>
      <div className="tp-shop__layout">
        <Tile
          className="tp-shop__queue"
          titleId={`${idBase}:queue`}
          title={t.queue.short}
          level={4}
          intro={t.queueHint}
        >
          {queued.length === 0 ? <p>{t.emptyQueue.short}</p> : null}
          <PriorityQueue
            label={t.queue.short}
            items={queued.map((entry) => ({
              id: entry.id,
              label: nameOf(entry.label),
              tone: toneOf(sections.get(entry.id)),
            }))}
            onMove={(upgrade, toIndex) => {
              const target = queued[toIndex];
              const to = vm.entries.findIndex((entry) => entry.id === target?.id);
              if (to >= 0) props.onMove(upgrade, to);
            }}
            onAdd={props.onInclude}
          />
          <WaveRanges {...parts} />
        </Tile>
        <Tile
          className="tp-shop__picker"
          titleId={`${idBase}:picker`}
          title={t.picker.short}
          level={4}
          intro={t.pickerHint}
        >
          <p className="tp-shop__hint">
            {t.chipFields.short}
            <HelpTip label={t.chipFields.short}>
              <p>{t.chipFields.why}</p>
            </HelpTip>
          </p>
          {vm.orderProvisional ? <p className="tp-shop__hint">{t.orderProvisional.short}</p> : null}
          {vm.picker.map((section) => (
            <Page key={section.key} section={section} {...parts} />
          ))}
          {reasons.length === 0 ? null : (
            <ul className="tp-shop__reasons">
              {reasons.map((item) => (
                <li key={item.id} id={`${idBase}:reason:${item.id}`} className="tp-shop__hint">
                  {nameOf(item.label)}
                  {t.space}
                  {t.excludedReason.short}
                  {t.space}
                  {item.exclusionReason === null ? null : (
                    <ServerValue kind="message" value={item.exclusionReason} />
                  )}
                </li>
              ))}
            </ul>
          )}
          <NeverBuy {...parts} />
        </Tile>
      </div>
      {problems.length === 0 ? null : (
        <ul className="tp-shop__problems" aria-label={t.fieldProblems.short}>
          {problems.map(({ entry, field, problem }) => (
            <li
              key={`${entry.id}:${field}`}
              id={problemId(idBase, entry.id, field)}
              className="tp-shop__problem"
            >
              {nameOf(entry.label)}
              {t.space}
              {FIELD_LABELS[field].short}
              {t.space}
              {t.problems[problem].short}
            </li>
          ))}
        </ul>
      )}
      {review.problems === 0 ? null : (
        <p className="tp-shop__problem">{t.problemCount(review.problems)}</p>
      )}
    </div>
  );
}
