import { entry } from './entry.ts';

/**
 * A2-7: the names of timed actions and gates and the labels of their fields, one table each,
 * read through core/actions.ts actionName and fieldLabel (Dashboard This battle, Runs editors
 * and battle details). Until the projection's labels are shown (C1, C2) these are the words.
 */
export const actions = {
  names: {
    ad_gems: entry('Ad gems'),
    floating_gems: entry('Floating gems'),
    shopping: entry('Shopping'),
    rewards: entry('Rewards'),
    abilities: entry('Abilities'),
    rescue: entry('Rescue'),
    repeat: entry('Repeat'),
  },
  otherName: entry('Other routine'),
  fields: {
    enabled: entry('On'),
    interval_sec: entry('Every'),
    window_sec: entry('Window', 'How long one attempt may take.'),
    tap_interval_sec: entry('Tap every', 'Time between taps on a floating gem.'),
  },
  otherField: entry('Setting'),
};
