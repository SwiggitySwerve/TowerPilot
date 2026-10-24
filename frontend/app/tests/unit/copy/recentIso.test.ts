import { expect, it } from 'vitest';
import { recent } from '../../../src/copy/dashboard/recent.ts';

/** The pre-change rule, inline, as the reference the switch to isoText must match. */
const before = {
  nextCheck: (at: number, offsetSec: number | null) =>
    `next check ${new Date((at + (offsetSec ?? 0)) * 1000).toISOString().slice(11, 16)}${offsetSec === null ? ' UTC' : ''}`,
  recordedAt: (at: number) => `Recorded end time: ${new Date(at * 1000).toISOString()}`,
};

it('AC1 recent next check and recorded end time read through isoText with unchanged output', () => {
  for (const at of [0, 1800000002, 1800000072.6999998, 1761264000, -86400, 8.64e12 - 86400])
    for (const offset of [null, 0, -21600, 3600, 19800]) {
      expect(String(recent.nextCheck(at, offset))).toBe(before.nextCheck(at, offset));
      expect(String(recent.recordedAt(at))).toBe(before.recordedAt(at));
    }
});

it('AC1 a time no date can hold still throws the same RangeError', () => {
  for (const at of [Number.NaN, Number.POSITIVE_INFINITY, 8.64e12 + 1]) {
    expect(() => before.recordedAt(at)).toThrow(RangeError);
    expect(() => recent.recordedAt(at)).toThrow(RangeError);
    expect(() => recent.nextCheck(at, null)).toThrow(RangeError);
  }
});
