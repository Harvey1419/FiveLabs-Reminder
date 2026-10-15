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
