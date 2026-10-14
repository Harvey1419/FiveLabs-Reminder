import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTargetTime, formatHumanFriendlyDateTime, formatHumanFriendlyDate, nowISO, nowHuman, humanizeTimeUntil, formatLocalDateTime, formatLocalISO, addMinutes } from '../../../src/shared/time.js';
const reference = new Date('2027-01-14T17:49:00Z');
afterEach(() => vi.useRealTimers());
describe('typed target parsing and date presentation', () => {
  it('keeps canonical ISO durations as elapsed time even across DST', () => {
    expect(parseTargetTime('PT2H15M', 'America/Bogota', reference)?.toISOString()).toBe('2027-01-14T20:04:00.000Z');
    expect(parseTargetTime('P1D', 'America/Los_Angeles', new Date('2027-03-13T20:00:00Z'))?.toISOString()).toBe('2027-03-14T20:00:00.000Z');
    expect(parseTargetTime('P0D', 'UTC', reference)).toBeNull(); expect(parseTargetTime('P1M', 'UTC', reference)).toBeNull(); expect(parseTargetTime('P1Y', 'UTC', reference)).toBeNull();
  });
  it('preserves explicit offsets and anchors offset-free ISO clocks to the user zone', () => {
    expect(parseTargetTime('2031-01-14T08:00:00-05:00', 'UTC', reference)?.toISOString()).toBe('2031-01-14T13:00:00.000Z');
    expect(parseTargetTime('2031-01-14T08:00:00Z', 'America/Bogota', reference)?.toISOString()).toBe('2031-01-14T08:00:00.000Z');
    expect(parseTargetTime('2031-01-14T08:00:00', 'America/Bogota', reference)?.toISOString()).toBe('2031-01-14T13:00:00.000Z');
  });
  it('retains legacy relative phrases and an explicit no-roll time-only option', () => {
    expect(parseTargetTime('en 10 minutos', 'America/Bogota', reference)?.toISOString()).toBe('2027-01-14T17:59:00.000Z');
    expect(parseTargetTime('8 a. m.', 'America/Bogota', reference, { rollForwardTimeOnly: false })?.toISOString()).toBe('2027-01-14T13:00:00.000Z');
    expect(parseTargetTime('8 AM', 'America/Bogota', reference)?.toISOString()).toBe('2027-01-15T13:00:00.000Z');
  });
  it('advances explicit tomorrow and expired clocks by local calendar day across DST', () => {
    const spring = new Date('2027-03-13T20:00:00Z');
    expect(parseTargetTime('tomorrow at 8 AM', 'America/Los_Angeles', spring)?.toISOString()).toBe('2027-03-14T15:00:00.000Z');
    expect(parseTargetTime('08:00', 'America/Los_Angeles', spring)?.toISOString()).toBe('2027-03-14T15:00:00.000Z');
    expect(parseTargetTime('mañana a las 8 AM', 'America/Los_Angeles', new Date('2027-11-06T19:00:00Z'))?.toISOString()).toBe('2027-11-07T16:00:00.000Z');
  });
  it('labels tomorrow correctly at late-night spring and early-morning fall boundaries', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2027-03-14T07:30:00Z'));
    expect(formatHumanFriendlyDateTime('2027-03-14T19:00:00Z', 'America/Los_Angeles', 'en')).toBe('Tomorrow at 12:00 PM');
    expect(formatHumanFriendlyDate('2027-03-14T19:00:00Z', 'America/Los_Angeles', 'en')).toBe('Tomorrow');
    vi.setSystemTime(new Date('2027-11-07T07:30:00Z'));
    expect(formatHumanFriendlyDateTime('2027-11-08T20:00:00Z', 'America/Los_Angeles', 'es')).toBe('Mañana a las 12:00 PM');
    expect(formatHumanFriendlyDate('2027-11-08T20:00:00Z', 'America/Los_Angeles', 'es')).toBe('Mañana');
  });
  it('retains year-aware reminder formatting as an opt-in across local year boundaries', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-12-31T20:00:00Z'));
    expect(formatHumanFriendlyDateTime('2027-01-01T13:00:00Z', 'America/Bogota', 'en')).toBe('Tomorrow at 8:00 AM');
    const text = formatHumanFriendlyDateTime('2027-01-01T13:00:00Z', 'America/Bogota', 'en', { includeYearWhenDifferent: true });
    expect(text).toContain('January 1, 2027'); expect(text).not.toContain('Tomorrow');
  });
  it('preserves unparseable display text and rejects unsupported empty target strings', () => {
    expect(formatHumanFriendlyDateTime('invalid', 'UTC', 'en')).toBe('invalid'); expect(formatHumanFriendlyDate('invalid', 'UTC', 'en')).toBe('invalid');
    expect(formatHumanFriendlyDateTime(null)).toBe(''); expect(parseTargetTime(null, 'UTC', reference)).toBeNull(); expect(parseTargetTime('unparseable', 'UTC', reference)).toBeNull();
  });
  it('does not read inherited month entries in legacy natural date parsing', () => {
    expect(parseTargetTime('17 de constructor', 'America/Bogota', reference)?.toISOString()).toBe('2027-01-17T14:00:00.000Z');
    expect(parseTargetTime('17 de enero de 2028 a las 8 AM', 'America/Bogota', reference)?.toISOString()).toBe('2028-01-17T13:00:00.000Z');
  });
  it('keeps local current-time output and relative labels tied to the supplied/frozen clock', () => {
    vi.useFakeTimers(); vi.setSystemTime(reference);
    expect(nowISO('America/Bogota', reference)).toBe('2027-01-14T12:49:00-05:00'); expect(nowHuman('America/Bogota', 'en', reference)).toContain('January');
    expect(humanizeTimeUntil(new Date(reference.getTime()+10*60000), 'en')).toEqual({ value: 10, unit: 'minutes', label: '10 minutes' });
    expect(humanizeTimeUntil(reference, 'pt').label).toBe('agora');
  });
  it('retains local ISO/string formatting helpers without mutating a date input', () => {
    vi.useFakeTimers(); vi.setSystemTime(reference);
    const input = new Date('2027-01-14T15:00:00Z');
    expect(formatLocalISO(input, 'America/Bogota')).toBe('2027-01-14T10:00:00'); expect(formatLocalDateTime(input, 'America/Bogota', 'en-US')).toContain('2027');
    expect(addMinutes('2027-01-14T10:00:00', 30, 'America/Bogota')).toBe('2027-01-14T10:30:00'); expect(input.toISOString()).toBe('2027-01-14T15:00:00.000Z');
  });
});
