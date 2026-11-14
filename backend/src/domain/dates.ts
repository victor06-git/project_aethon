// ISO date helpers (YYYY-MM-DD, UTC). Pure, no I/O.
const DAY_MS = 86_400_000;

export const addDays = (iso: string, days: number): string => new Date(Date.parse(iso) + days * DAY_MS).toISOString().slice(0, 10);

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

/** Whole months from `from` to `to`, never negative. */
export function monthsBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.max(0, (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0));
}

export const longDate = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Same day of the month `months` later; the 31st becomes the last day of a shorter month. */
export function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}
