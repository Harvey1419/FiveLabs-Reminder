import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIMEZONE, computeOffsetMinutes, zonedTimeToUtc, getLocalDateParts, shiftZonedCalendarDays } from '../../../src/shared/time.js';
import { resolveTypedSchedule } from '../../../src/agent/orchestration/typed-schedule.js';
describe('typed timezone and local calendar primitives', () => {
  it('returns exact offset strings for seasonal and fractional-hour zones', () => {
    const winter = new Date('2027-01-14T17:49:00Z'), summer = new Date('2027-07-14T17:49:00Z');
    expect(DEFAULT_TIMEZONE).toBe('America/Bogota'); expect(computeOffsetMinutes('America/Bogota', winter)).toBe('-05:00'); expect(computeOffsetMinutes('UTC', winter)).toBe('+00:00');
    expect(computeOffsetMinutes('America/Los_Angeles', winter)).toBe('-08:00'); expect(computeOffsetMinutes('America/Los_Angeles', summer)).toBe('-07:00'); expect(computeOffsetMinutes('Asia/Kolkata', winter)).toBe('+05:30'); expect(computeOffsetMinutes('Asia/Kathmandu', winter)).toBe('+05:45');
  });
  it('anchors local date components to the requested zone at a UTC date boundary', () => {
    expect(getLocalDateParts('2027-01-14T00:30:00Z', 'America/Bogota')).toEqual({ year: 2027, month: 1, day: 13, dayOfWeek: 3 });
    expect(getLocalDateParts('2027-01-14T00:30:00Z', 'UTC')).toEqual({ year: 2027, month: 1, day: 14, dayOfWeek: 4 });
  });
  it('converges local clock conversion when the naive UTC guess crosses a DST boundary', () => {
    expect(zonedTimeToUtc(2027, 3, 14, 12, 0, 0, 'America/Los_Angeles').toISOString()).toBe('2027-03-14T19:00:00.000Z');
    expect(zonedTimeToUtc(2027, 11, 7, 12, 0, 0, 'America/Los_Angeles').toISOString()).toBe('2027-11-07T20:00:00.000Z');
    expect(zonedTimeToUtc(2027, 1, 14, 8, 15, 0, 'Asia/Kathmandu').toISOString()).toBe('2027-01-14T02:30:00.000Z');
  });
  it('preserves local noon across a 23-hour calendar day without mutating the input', () => {
    const input = new Date('2027-03-13T20:00:00Z'); const shifted = shiftZonedCalendarDays(input, 1, 'America/Los_Angeles');
    expect(shifted?.toISOString()).toBe('2027-03-14T19:00:00.000Z'); expect(shifted!.getTime() - input.getTime()).toBe(23 * 3600000); expect(input.toISOString()).toBe('2027-03-13T20:00:00.000Z');
  });
  it('preserves local noon across a 25-hour day and supports reverse shifts and year rollover', () => {
    const shifted = shiftZonedCalendarDays('2027-11-06T19:00:00Z', 1, 'America/Los_Angeles'); expect(shifted?.toISOString()).toBe('2027-11-07T20:00:00.000Z');
    expect(shiftZonedCalendarDays(shifted, -1, 'America/Los_Angeles')?.toISOString()).toBe('2027-11-06T19:00:00.000Z');
    expect(shiftZonedCalendarDays('2028-01-01T04:30:00Z', 1, 'America/Bogota')?.toISOString()).toBe('2028-01-02T04:30:00.000Z');
  });
  it('retains shift rejection and legacy second-level precision semantics', () => {
    expect(shiftZonedCalendarDays('invalid', 1)).toBeNull(); expect(shiftZonedCalendarDays('2027-01-14T15:00:00Z', 1.5)).toBeNull();
    expect(shiftZonedCalendarDays('2027-01-14T15:00:00.123Z', '0')?.toISOString()).toBe('2027-01-14T15:00:00.000Z');
  });
  it('retains existing invalid-zone fallbacks and strict local-part exceptions', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(computeOffsetMinutes('Invalid/Zone', '2027-01-14T15:00:00Z')).toBe('-05:00'); expect(zonedTimeToUtc(2027, 1, 14, 8, 0, 0, 'Invalid/Zone').toISOString()).toBe('2027-01-14T08:00:00.000Z');
      expect(getLocalDateParts.bind(null, '2027-01-14T15:00:00Z', 'Invalid/Zone')).toThrow(RangeError); expect(getLocalDateParts.bind(null, 'invalid', 'UTC')).toThrow(RangeError); expect(warn).toHaveBeenCalled(); expect(error).toHaveBeenCalled();
    } finally { warn.mockRestore(); error.mockRestore(); }
  });
  it('keeps strict schedule round-trip rejection separate from primitive gap conversion', () => {
    const result = resolveTypedSchedule({ kind: 'calendar_date_time', year: 2027, month: 3, day: 14, hour: 2, minute: 30, clockMode: 'explicit_24h' }, { referenceTime: new Date('2027-03-13T20:00:00Z'), timezone: 'America/Los_Angeles' });
    expect(result).toMatchObject({ valid: false, errorCode: 'INVALID_LOCAL_TIME' });
  });
});
