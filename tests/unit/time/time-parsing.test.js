import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTargetTime, shiftZonedCalendarDays } from '../../../src/shared/time.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('deterministic relative time parsing', () => {
  it.each([
    ['PT2M', 2 * 60 * 1000],
    ['PT1H30M', 90 * 60 * 1000],
    ['P1D', 24 * 60 * 60 * 1000],
    ['P1W', 7 * 24 * 60 * 60 * 1000],
  ])('resolves canonical duration %s from one explicit request time', (input, offsetMs) => {
    const requestTime = new Date('2026-09-04T19:00:00.000Z');

    expect(parseTargetTime(input, 'America/Bogota', requestTime)?.toISOString())
      .toBe(new Date(requestTime.getTime() + offsetMs).toISOString());
  });

  it.each(['PT', 'P0D', 'P1M', 'two minutes'])('rejects non-canonical relative value %s', (input) => {
    expect(parseTargetTime(input, 'America/Bogota', new Date('2026-09-04T19:00:00.000Z'))).toBeNull();
  });

  it.each([
    ['in 2 minutes', 2 * 60 * 1000],
    ['in 1 minute', 60 * 1000],
    ['en 5 minutos', 5 * 60 * 1000],
    ['dentro de 2 horas', 2 * 60 * 60 * 1000],
    ['in 1 day', 24 * 60 * 60 * 1000],
    ['en 1 semana', 7 * 24 * 60 * 60 * 1000],
  ])('keeps legacy compatibility for %s during migration', (input, offsetMs) => {
    const now = new Date('2026-09-04T19:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    expect(parseTargetTime(input, 'America/Bogota')?.toISOString())
      .toBe(new Date(now.getTime() + offsetMs).toISOString());
  });

  it('can disable silent next-day rollover for reminder mutations', () => {
    const requestTime = new Date('2026-09-05T03:18:00.000Z'); // 10:18 PM in Bogota

    expect(parseTargetTime('4:00 PM', 'America/Bogota', requestTime, { rollForwardTimeOnly: false })?.toISOString())
      .toBe('2026-09-04T21:00:00.000Z');
    expect(parseTargetTime('4:00 PM', 'America/Bogota', requestTime)?.toISOString())
      .toBe('2026-09-05T21:00:00.000Z');
  });

  it('preserves local wall-clock time when tomorrow crosses a DST boundary', () => {
    const nineAmBeforeFallBack = new Date('2026-10-31T13:00:00.000Z');

    expect(shiftZonedCalendarDays(nineAmBeforeFallBack, 1, 'America/New_York')?.toISOString())
      .toBe('2026-11-01T14:00:00.000Z');
  });
});
