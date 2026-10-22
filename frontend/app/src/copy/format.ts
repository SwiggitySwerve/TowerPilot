/**
 * Formatting shared by the catalogue's modules (one rule per fact). Whole
 * seconds as "45 s", "12 m", "12 m 05 s"; used where a number of seconds is
 * shown as a readable duration.
 */
/**
 * A server time (epoch seconds) as the date and time it names, en-US in this browser's time
 * zone; never compared with this browser's clock.
 */
export function serverDateText(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString('en-US');
}

export function durationText(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds));
  if (n < 60) return `${String(n)} s`;
  const rest = n % 60;
  return rest === 0
    ? `${String(Math.floor(n / 60))} m`
    : `${String(Math.floor(n / 60))} m ${String(rest).padStart(2, '0')} s`;
}
