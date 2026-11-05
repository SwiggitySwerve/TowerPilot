import { entry, made } from './entry.ts';
import type { CopyText } from './text.ts';

/**
 * F6-12 shopping queues (brief backend/logs/reviews/ui-pages/f6-12-shopping-brief.md): the words
 * of the one queue editor shared by a saved run, a battle's live queue and a shared library
 * policy. Meanings follow backend/towerpilot_workflows/shopping_plan.py and
 * backend/interactions/shopper.py.
 */
export const shopping = {
  space: made(' '),
  rules: entry('Purchase rules'),
  reserve: entry(
    'Cash reserve',
    'Shopping never spends below this much cash. Required: type 0 to allow spending all cash.',
  ),
  reserveHint: entry('Type 0 to keep none back.', 'Cash kept back. Decimals are allowed.'),
  mode: entry('Purchase pattern'),
  cadence: entry('Cadence'),
  choose: entry('Choose one'),
  modes: {
    highest_affordable: entry(
      'First affordable in priority order',
      'Each turn buys the first upgrade in the queue that is affordable.',
    ),
    round_robin: entry('Round robin', 'Each turn moves on to the next upgrade in the queue.'),
    weighted_split: entry(
      'Weighted split',
      'Each upgrade gets its weight in confirmed single purchases before the next one gets its turn.',
    ),
  },
  cadences: {
    single_attempt: entry('One attempt per sweep', 'Each shopping sweep tries one purchase.'),
    while_affordable: entry(
      'Keep buying while affordable',
      'A sweep keeps buying while fresh evidence shows enough cash, within its bounds.',
    ),
  },
  unknownChoice: entry('Not a known choice; shown as the server sent it'),
  queue: entry('Queue (priority order)'),
  queueHint: entry(
    'Leaving an upgrade out keeps its limits and place.',
    'From and Until limit each upgrade to a wave range. A blank From uses the server default; Until is exclusive, and a blank Until means no last wave.',
  ),
  emptyQueue: entry('No upgrades in the queue. Include upgrades from the shop pages.'),
  included: entry('Included in queue'),
  added: entry('Added in this draft'),
  tapLimit: entry('Tap attempts this battle'),
  tapLimitHint: entry('Blank means unlimited.', 'Counts taps sent, not levels bought.'),
  weight: entry('Weight'),
  weightHint: entry(
    'Blank uses the server default.',
    'Confirmed single purchases per weighted turn.',
  ),
  fromWave: entry('From wave'),
  fromWaveShort: entry('From'),
  fromWaveHint: entry('Blank uses the server default.'),
  untilWave: entry('Until wave (exclusive)'),
  untilWaveShort: entry('Until'),
  untilWaveHint: entry('Blank means no last wave.'),
  waves: entry('Waves and weight'),
  unlimited: entry('∞'),
  times: entry('×'),
  problemLine: (item: CopyText, field: CopyText, problem: CopyText) =>
    made(`${item} ${field}: ${problem}`),
  fieldProblems: entry('Fields to fix'),
  up: entry('Move up'),
  down: entry('Move down'),
  firstPlace: entry('Already first.'),
  lastPlace: entry('Already last.'),
  moved: (position: number) => made(`Moved to position ${String(position)}.`),
  position: (position: number) => made(`${String(position)}.`),
  problems: {
    empty: entry('Required.'),
    not_a_number: entry(
      'Not a number. Use digits, an optional minus and an optional decimal point.',
    ),
    not_a_choice: entry('Not a choice this editor can send. Choose one of the listed options.'),
  },
  problemCount: (count: number) =>
    made(
      count === 1
        ? '1 field needs a value before this queue can be sent.'
        : `${String(count)} fields need a value before this queue can be sent.`,
    ),
  /** The queue's own fields that block sending, named (entry fields are listed one by one). */
  problemFields: (names: readonly CopyText[]) =>
    made(
      `${names.length === 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`} ${names.length === 1 ? 'needs' : 'need'} a valid value before this queue can be sent.`,
    ),
  picker: entry('Shop pages'),
  /** One line for the pages; how a chip's fields count lives in its help. */
  pickerHint: entry(
    'Selecting an upgrade adds it to the end of the queue and shows its tap limit.',
    'Selecting an excluded upgrade removes its exclusion. The tap limit counts taps sent, not levels bought; blank means unlimited. In Weighted split a selected upgrade also shows its weight: the confirmed single purchases per weighted turn; blank uses the server default.',
  ),
  /** Weighted split: the key to a selected chip's two numbers, in the order they appear. */
  pickerHintWeighted: entry(
    'Selecting an upgrade adds it to the end of the queue and shows its tap limit × weight.',
    'Selecting an excluded upgrade removes its exclusion. The tap limit counts taps sent, not levels bought; blank means unlimited. The weight is the confirmed single purchases per weighted turn; blank uses the server default.',
  ),
  sections: {
    attack: entry('Attack'),
    defense: entry('Defense'),
    utility: entry('Utility'),
  },
  otherSection: entry('Other'),
  /** The row that shows one shop page at a time on a narrow screen. */
  pageTabs: entry('Shop pages to show'),
  excluded: entry('Never buy'),
  noneExcluded: entry('No upgrade is kept out.'),
  excludeAdd: entry('Upgrade to keep out'),
  excludeSend: entry('Keep out'),
  excludePick: entry('Choose an upgrade'),
  excludedReason: entry('Excluded by default:'),
  orderProvisional: entry(
    'Shop order shown here is provisional until it is verified on this account. It does not show what the account owns.',
  ),
};
