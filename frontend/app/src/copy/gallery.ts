import { entry, made } from './entry.ts';

/**
 * The item gallery (`#gallery`, not in the navigation): synthetic labels only, so it
 * shows every state of the src/ui item primitives without naming anything of a real
 * account. Tests reuse the sample names.
 */
export const gallery = {
  pageName: entry('Item gallery'),
  intro: entry(
    'Every shared item primitive in every state, drawn from made-up names. Nothing here is saved.',
  ),
  sections: {
    states: entry('Toggle chip states'),
    sizes: entry('Grids of 3, 12 and 48 items'),
    narrow: entry('Narrow container'),
    marks: entry('Marked names'),
    queue: entry('Priority queue'),
    density: entry('Record rows, tags and dots'),
    fields: entry('Compact fields'),
    shown: entry('Long lists'),
  },
  states: {
    off: entry('Off'),
    on: entry('On'),
    disabled: entry('Disabled'),
    disabledReason: entry('Needs a setting that is not available here'),
    unsupported: entry('Unsupported'),
    invalid: entry('Invalid'),
    invalidReason: entry('The limit is out of range'),
    long: entry('A deliberately long sample name that has to wrap across more than two lines'),
  },
  fields: {
    tapLimit: entry('Tap limit'),
    perTurn: entry('Per turn'),
    unlimited: entry('∞'),
    name: entry('Display name'),
    count: entry('Count'),
    savePending: entry('Pending save'),
    saveError: entry('Error after save'),
    saveFailed: entry('The sample value was refused'),
  },
  grids: {
    three: entry('3 items'),
    twelve: entry('12 items'),
    fortyEight: entry('48 items'),
    marked: entry('Names with marks'),
  },
  queue: {
    label: entry('Sample queue'),
    sources: entry('Sample sources'),
  },
  density: {
    row: entry('Sample row'),
    kind: entry('Sample kind'),
    summary: entry('A short sample summary'),
    edit: entry('Edit'),
    copy: entry('Copy'),
    dots: entry('Status dots'),
  },
  shown: {
    all: entry('Every item, no fold'),
    folded: entry('First 10 items, the rest behind a disclosure'),
    more: entry('Show more'),
  },
  /** Sample item names: "Sample item 7". */
  itemName: (index: number) => made(`Sample item ${String(index)}`),
  /** Sample record names, used by rows and lists. */
  recordName: (index: number) => made(`Sample record ${String(index)}`),
};
