import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDayQueryBounds } from '../../../src/shared/day-query-bounds.js';
import { getDayBounds, detectLocaleFromPhone, detectTimezoneFromPhone, isRecognizedNanpAreaCode, detectTimezoneFromLocationText, getNearestCityFromCoordinates, detectTimezoneFromCoordinates, KNOWN_MAJOR_CITIES } from '../../../src/shared/time.js';

afterEach(() => vi.useRealTimers());
describe('typed day bounds and locale/timezone inference', () => {
  it('delegates native string coercion and preserves the next-event null end', () => {
    const start = new Date('2027-01-14T12:00:00Z');
    const resolve = vi.fn(() => ({ timeMin: start, timeMax: null, isNextEvent: true as const, maxResults: 1 as const, scope: 'next_event' as const }));
    const bounds = createDayQueryBounds({ resolveCalendarTemporalScope: resolve });
    expect(bounds.getDayBounds(' NEXT_EVENT ', 'UTC')).toEqual({ timeMin: start, timeMax: null });
    expect(resolve).toHaveBeenCalledWith({ scope: 'next_event', fullDay: true }, 'UTC');
    bounds.getDayBounds('2027-01-17T10:00:00Z', 'UTC');
    expect(resolve).toHaveBeenLastCalledWith({ scope: 'explicit_date', date: '2027-01-17t10:00:00z' }, 'UTC');
    bounds.getDayBounds(null); expect(resolve).toHaveBeenLastCalledWith({ scope: 'today', fullDay: true }, 'America/Bogota');
  });
  it('returns calendar-local semi-open days of 23 and 25 hours across DST', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2027-01-14T12:00:00Z'));
    const spring = getDayBounds('2027-03-14', 'America/Los_Angeles');
    expect(spring.timeMin.toISOString()).toBe('2027-03-14T08:00:00.000Z');
    expect(spring.timeMax?.toISOString()).toBe('2027-03-15T07:00:00.000Z');
    const fall = getDayBounds('2027-11-07', 'America/Los_Angeles');
    expect(fall.timeMax!.getTime()-fall.timeMin.getTime()).toBe(25*3600000);
  });
  it('keeps independent BSUID language and timezone fallbacks', () => {
    expect(detectLocaleFromPhone('SV.123')).toBe('es-CO');
    expect(detectTimezoneFromPhone('SV.123')).toBe('America/Bogota');
    expect(detectLocaleFromPhone('BR.123')).toBe('en-US');
    expect(detectTimezoneFromPhone('BR.123')).toBe('America/Sao_Paulo');
    expect(detectTimezoneFromPhone('co.123')).toBe('America/Bogota');
    expect(detectLocaleFromPhone({ phone: '+57' })).toBe('es-CO');
    expect(detectTimezoneFromPhone('')).toBe('America/Bogota');
  });
  it('retains NANP match priority, fallback and exact area-code membership', () => {
    expect(detectTimezoneFromPhone('+1 (208) 123-4567')).toBe('America/Boise');
    expect(detectTimezoneFromPhone('+1 415 1234567')).toBe('America/Los_Angeles');
    expect(detectTimezoneFromPhone('+1 999 1234567')).toBe('America/New_York');
    expect(isRecognizedNanpAreaCode('208')).toBe(true);
    expect(isRecognizedNanpAreaCode(208)).toBe(false);
    expect(isRecognizedNanpAreaCode(' 208')).toBe(false);
  });
  it('normalizes accents and preserves first matching city-map priority', () => {
    expect(detectTimezoneFromLocationText('Estoy en Bogotá')).toBe('America/Bogota');
    expect(detectTimezoneFromLocationText('Bogotá y Madrid')).toBe('Europe/Madrid');
    expect(detectTimezoneFromLocationText('un lugar desconocido')).toBeNull();
    expect(detectTimezoneFromLocationText(null)).toBeNull();
  });
  it('uses nearest-city matching before broad bounding boxes', () => {
    const cancun = getNearestCityFromCoordinates('21.1619', '-86.8515');
    expect(cancun).toMatchObject({ city: 'Cancún', tz: 'America/Cancun', distanceKm: 0 });
    expect(detectTimezoneFromCoordinates(21.1619, -86.8515)).toBe('America/Cancun');
    expect(detectTimezoneFromCoordinates(10, -70)).toBe('America/Bogota');
  });
  it('rejects absent/NaN and distant coordinates while preserving legacy coercion', () => {
    expect(getNearestCityFromCoordinates(null, 0)).toBeNull();
    expect(detectTimezoneFromCoordinates('invalid', 0)).toBeNull();
    expect(detectTimezoneFromCoordinates(Infinity, 0)).toBeNull();
    expect(getNearestCityFromCoordinates(0, 0)).toBeNull();
    expect(detectTimezoneFromCoordinates('', '')).toBeNull();
  });
  it('returns fresh nearest-city projections without mutating the frozen catalogue', () => {
    expect(Object.isFrozen(KNOWN_MAJOR_CITIES)).toBe(true);
    const city = getNearestCityFromCoordinates(4.7110, -74.0721)!;
    city.city = 'Changed';
    expect(getNearestCityFromCoordinates(4.7110, -74.0721)?.city).toBe('Bogotá');
  });
});
