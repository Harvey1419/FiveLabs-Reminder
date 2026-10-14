import { describe, expect, it } from 'vitest';
import { resolveTypedSchedule, mergePendingSchedule } from '../../../src/agent/orchestration/typed-schedule.js';
const context = { referenceTime: new Date('2027-01-14T17:49:00Z'), timezone: 'America/Bogota' };
describe('typed structured temporal resolution', () => {
  it('selects the nearest future 12-hour clock on the same local date and defaults minutes', () => {
    const result = resolveTypedSchedule({ kind: 'local_time', hour: 4, clockMode: 'ambiguous_12h' }, context);
    expect(result).toMatchObject({ valid: true, canonical: '2027-01-14T21:00:00.000Z', canonicalDate: '2027-01-14', resolvedHour: 16, clockResolution: 'nearest_future_on_local_date' });
  });
  it('retains explicit midnight/noon and the same-date fallback when both ambiguous clocks elapsed', () => {
    expect(resolveTypedSchedule({ kind: 'local_time', hour: 12, clockMode: 'explicit_am' }, context)).toMatchObject({ canonical: '2027-01-14T05:00:00.000Z' });
    expect(resolveTypedSchedule({ kind: 'local_time', hour: 12, clockMode: 'explicit_pm' }, context)).toMatchObject({ canonical: '2027-01-14T17:00:00.000Z' });
    expect(resolveTypedSchedule({ kind: 'local_time', hour: 4, clockMode: 'ambiguous_12h' }, { ...context, referenceTime: new Date('2027-01-14T23:00:00Z') })).toMatchObject({ canonicalDate: '2027-01-14', resolvedHour: 16 });
  });
  it('rejects a nonexistent DST clock rather than accepting a normalized different local hour', () => {
    expect(resolveTypedSchedule({ kind: 'calendar_date_time', year: 2027, month: 3, day: 14, hour: 2, minute: 30, clockMode: 'explicit_24h' }, { referenceTime: new Date('2027-03-13T20:00:00Z'), timezone: 'America/Los_Angeles' })).toMatchObject({ valid: false, errorCode: 'INVALID_LOCAL_TIME' });
  });
  it('validates real calendar dates and retains date-only all-day metadata', () => {
    expect(resolveTypedSchedule({ kind: 'calendar_date_time', year: 2027, month: 2, day: 29 }, context)).toMatchObject({ valid: false, errorCode: 'INVALID_CALENDAR_DATE' });
    expect(resolveTypedSchedule({ kind: 'calendar_date_time', year: 2028, month: 2, day: 29 }, context)).toMatchObject({ valid: true, isAllDay: true, canonicalDate: '2028-02-29' });
    expect(resolveTypedSchedule({ kind: 'relative_day_time', dayOffset: 1 }, context)).toMatchObject({ valid: true, isAllDay: true, canonicalDate: '2027-01-15' });
  });
  it('preserves an explicit no-op for missing inherited context and a known occurrence base', () => {
    expect(resolveTypedSchedule({ kind: 'inherit_context' }, context)).toMatchObject({ valid: true, inherited: false, canonical: null, date: null });
    const base = new Date('2027-01-17T15:00:00Z');
    expect(resolveTypedSchedule({ kind: 'inherit_context' }, { ...context, baseDate: base })).toMatchObject({ valid: true, inherited: true, canonical: base.toISOString() });
    expect(resolveTypedSchedule({ kind: 'local_time', hour: 8, clockMode: 'explicit_am' }, { ...context, baseDate: base })).toMatchObject({ canonicalDate: '2027-01-17', canonical: '2027-01-17T13:00:00.000Z' });
  });
  it('enforces offset/week bounds and refuses inherited weekday properties', () => {
    expect(resolveTypedSchedule({ kind: 'relative_offset', offsetMinutes: 525601 }, context)).toMatchObject({ errorCode: 'INVALID_RELATIVE_OFFSET' });
    expect(resolveTypedSchedule({ kind: 'relative_day_time', dayOffset: -1 }, context)).toMatchObject({ errorCode: 'INVALID_DAY_OFFSET' });
    expect(resolveTypedSchedule({ kind: 'weekday_time', weekday: 'friday', weekOffset: 53 }, context)).toMatchObject({ errorCode: 'INVALID_WEEK_OFFSET' });
    for (const weekday of ['constructor', '__proto__']) expect(resolveTypedSchedule({ kind: 'weekday_time', weekday }, context)).toMatchObject({ valid: false, errorCode: 'INVALID_WEEKDAY' });
  });
  it('merges partial clocks/dates with cloned pending schedules without mutating source fields', () => {
    const base = Object.freeze({ kind: 'calendar_date_time', year: 2027, month: 1, day: 17, hour: 10, minute: 30, clockMode: 'explicit_am', metadata: { retained: true } });
    const clock = mergePendingSchedule(base, { kind: 'local_time', hour: 4, clockMode: 'explicit_pm' });
    expect(clock).toMatchObject({ kind: 'calendar_date_time', year: 2027, month: 1, day: 17, hour: 4, minute: 0, clockMode: 'explicit_pm' });
    expect(clock?.metadata).not.toBe(base.metadata); expect(base.minute).toBe(30);
    expect(mergePendingSchedule(base, { kind: 'relative_day_time', dayOffset: 2 })).toMatchObject({ kind: 'relative_day_time', dayOffset: 2, hour: 10, minute: 30, clockMode: 'explicit_am' });
    expect(mergePendingSchedule(base, { kind: 'relative_offset', offsetMinutes: 20 })).toEqual({ kind: 'relative_offset', offsetMinutes: 20 });
  });
  it('normalizes structural day offsets while preserving typed failure envelopes and original input', () => {
    const input = Object.freeze({ kind: 'local_time', dayOffset: 1, hour: 9, clockMode: 'explicit_am' });
    expect(resolveTypedSchedule(input, context)).toMatchObject({ valid: true, temporalKind: 'relative_day_time', canonicalDate: '2027-01-15' });
    expect(input.kind).toBe('local_time'); expect(resolveTypedSchedule(null, context)).toMatchObject({ valid: false, errorCode: 'MISSING_SCHEDULE' });
    expect(resolveTypedSchedule({ kind: 'local_time', hour: 24 }, context)).toMatchObject({ valid: false, errorCode: 'MISSING_CLOCK_TIME' });
    expect(resolveTypedSchedule({ kind: 'relative_offset', offsetMinutes: 1 }, { ...context, referenceTime: 'invalid' })).toMatchObject({ valid: false, errorCode: 'INVALID_REFERENCE_TIME' });
  });
});
