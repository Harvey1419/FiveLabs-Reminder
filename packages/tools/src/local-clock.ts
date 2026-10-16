/** Search real instants so offset changes and repeated/skipped DST hours remain correct.
 * This resolves typed clock input, never natural-language text.
 */
export function nextLocalClock(clock: { readonly hour: number; readonly minute: number }, referenceTimeIso: string, timezone: string): string {
  const reference = Date.parse(referenceTimeIso);
  if (!Number.isFinite(reference)) throw new Error('Invalid temporal anchor');
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const first = Math.floor(reference / 60000) * 60000 + 60000;
  for (let offset = 0; offset < 48 * 60; offset++) {
    const candidate = first + offset * 60000;
    const parts = formatter.formatToParts(candidate);
    const hour = Number(parts.find(part => part.type === 'hour')?.value);
    const minute = Number(parts.find(part => part.type === 'minute')?.value);
    if (hour % 12 === clock.hour % 12 && minute === clock.minute) return new Date(candidate).toISOString();
  }
  throw new Error('No future local clock occurrence');
}

/** Resolve an explicit relative calendar day and 24-hour wall clock, not text.
 * Search real instants to reject skipped hours and retain the first future fold.
 * A past/nonexistent time on the requested day must never roll to another day.
 */
export function relativeLocalDayClock(clock: { readonly day: 'today' | 'tomorrow'; readonly hour: number; readonly minute: number }, referenceTimeIso: string, timezone: string): string {
  const reference = Date.parse(referenceTimeIso);
  if (!Number.isFinite(reference)) throw new Error('Invalid temporal anchor');
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = (instant: number) => {
    const values = formatter.formatToParts(instant);
    const part = (name: Intl.DateTimeFormatPartTypes) => Number(values.find(value => value.type === name)?.value);
    return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute') };
  };
  const local = parts(reference);
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day + (clock.day === 'tomorrow' ? 1 : 0)));
  const year = date.getUTCFullYear(), month = date.getUTCMonth() + 1, day = date.getUTCDate();
  const nominal = Date.UTC(year, month - 1, day, clock.hour, clock.minute);
  for (let offset = -24 * 60; offset <= 24 * 60; offset++) {
    const candidate = nominal + offset * 60000;
    if (candidate <= reference) continue;
    const actual = parts(candidate);
    if (actual.year === year && actual.month === month && actual.day === day && actual.hour === clock.hour && actual.minute === clock.minute) return new Date(candidate).toISOString();
  }
  throw new Error('No future occurrence on the requested local day');
}
