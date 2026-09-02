export const DEFAULT_TIMEZONE = 'America/Bogota';

const UNIT_WORDS = {
  es: { minutes: 'minuto', hours: 'hora', days: 'día', weeks: 'semana' },
  en: { minutes: 'minute', hours: 'hour', days: 'day', weeks: 'week' },
  pt: { minutes: 'minuto', hours: 'hora', days: 'dia', weeks: 'semana' },
};

/**
 * Meta WhatsApp Business-Scoped User ID (BSUID) ISO 3166-1 alpha-2 mapping.
 */
export const BSUID_COUNTRY_TIMEZONES = Object.freeze({
  CO: 'America/Bogota',
  MX: 'America/Mexico_City',
  AR: 'America/Argentina/Buenos_Aires',
  ES: 'Europe/Madrid',
  PE: 'America/Lima',
  CL: 'America/Santiago',
  EC: 'America/Guayaquil',
  VE: 'America/Caracas',
  BR: 'America/Sao_Paulo',
  US: 'America/New_York',
  CA: 'America/Toronto',
  GB: 'Europe/London',
  FR: 'Europe/Paris',
  DE: 'Europe/Berlin',
  IT: 'Europe/Rome',
  PT: 'Europe/Lisbon',
  UY: 'America/Montevideo',
  PY: 'America/Asuncion',
  BO: 'America/La_Paz',
  CR: 'America/Costa_Rica',
  PA: 'America/Panama',
  DO: 'America/Santo_Domingo',
  GT: 'America/Guatemala',
});

/**
 * E.164 International Dialing Code Prefixes.
 */
const COUNTRY_CALLING_CODES = Object.freeze([
  { prefix: '34', tz: 'Europe/Madrid' },
  { prefix: '57', tz: 'America/Bogota' },
  { prefix: '54', tz: 'America/Argentina/Buenos_Aires' },
  { prefix: '52', tz: 'America/Mexico_City' },
  { prefix: '56', tz: 'America/Santiago' },
  { prefix: '51', tz: 'America/Lima' },
  { prefix: '593', tz: 'America/Guayaquil' },
  { prefix: '58', tz: 'America/Caracas' },
  { prefix: '55', tz: 'America/Sao_Paulo' },
  { prefix: '44', tz: 'Europe/London' },
  { prefix: '33', tz: 'Europe/Paris' },
  { prefix: '49', tz: 'Europe/Berlin' },
  { prefix: '39', tz: 'Europe/Rome' },
  { prefix: '351', tz: 'Europe/Lisbon' },
]);

/**
 * US/Canada Area Code sets for O(1) matching.
 */
const US_BOISE_CODES = new Set(['208', '986']);
const US_PACIFIC_CODES = new Set([
  '206', '209', '213', '310', '323', '408', '415', '503', '509', '510',
  '530', '559', '562', '619', '626', '650', '661', '702', '707', '714',
  '760', '775', '805', '818', '831', '858', '909', '916', '925', '949',
  '951', '971',
]);
const US_MOUNTAIN_CODES = new Set([
  '303', '719', '720', '970', '480', '520', '602', '623', '928', '801',
  '385', '505', '575', '406', '307',
]);
const US_CENTRAL_CODES = new Set([
  '214', '281', '469', '512', '713', '832', '972', '312', '773', '847',
  '630', '815', '612', '651', '763', '952', '314', '636', '816',
]);
const US_EASTERN_CODES = new Set([
  '212', '315', '516', '518', '585', '607', '631', '646', '716', '718',
  '845', '914', '917', '929', '305', '786', '954', '407', '813', '202',
  '404', '678', '617', '215', '267', '412', '703', '571', '919', '704',
  '410', '443',
]);

/**
 * Natural language city and destination keyword map.
 */
const CITY_LOCATION_MAP = Object.freeze([
  { pattern: /\b(madrid|barcelona|valencia|sevilla|espana|spain|malaga|bilbao|ibiza|mallorca|zaragoza)\b/i, tz: 'Europe/Madrid' },
  { pattern: /\b(bogota|medellin|cali|barranquilla|cartagena|bucaramanga|pereira|manizales|colombia|santa marta)\b/i, tz: 'America/Bogota' },
  { pattern: /\b(buenos aires|caba|cordoba|rosario|mendoza|argentina|bariloche|la plata|mar del plata)\b/i, tz: 'America/Argentina/Buenos_Aires' },
  { pattern: /\b(ciudad de mexico|cdmx|mexico city|guadalajara|monterrey|cancun|mexico|puebla|tijuana|queretaro)\b/i, tz: 'America/Mexico_City' },
  { pattern: /\b(santiago de chile|santiago|chile|valparaiso|concepcion|antofagasta)\b/i, tz: 'America/Santiago' },
  { pattern: /\b(miami|orlando|nueva york|new york|nyc|boston|atlanta|washington|filadelfia|philadelphia|tampa)\b/i, tz: 'America/New_York' },
  { pattern: /\b(boise|idaho)\b/i, tz: 'America/Boise' },
  { pattern: /\b(los angeles|san francisco|seattle|las vegas|california|san diego|portland)\b/i, tz: 'America/Los_Angeles' },
  { pattern: /\b(chicago|dallas|houston|austin|san antonio|texas)\b/i, tz: 'America/Chicago' },
  { pattern: /\b(denver|colorado|phoenix|salt lake city|arizona)\b/i, tz: 'America/Denver' },
  { pattern: /\b(lima|cusco|cuzco|arequipa|peru)\b/i, tz: 'America/Lima' },
  { pattern: /\b(londres|london|reino unido|united kingdom|uk)\b/i, tz: 'Europe/London' },
  { pattern: /\b(paris|francia|france)\b/i, tz: 'Europe/Paris' },
  { pattern: /\b(tokio|tokyo|japon|japan)\b/i, tz: 'Asia/Tokyo' },
  { pattern: /\b(sao paulo|rio de janeiro|brasil|brazil)\b/i, tz: 'America/Sao_Paulo' },
]);

/**
 * GPS Bounding boxes for coordinates-based timezone resolution.
 */
const GPS_BOUNDING_BOXES = Object.freeze([
  { minLat: -4.5, maxLat: 13.5, minLon: -79.5, maxLon: -66.5, tz: 'America/Bogota' },
  { minLat: 35.0, maxLat: 44.5, minLon: -9.5, maxLon: 4.5, tz: 'Europe/Madrid' },
  { minLat: -55.5, maxLat: -21.5, minLon: -74.0, maxLon: -53.0, tz: 'America/Argentina/Buenos_Aires' },
  { minLat: 14.0, maxLat: 33.0, minLon: -118.5, maxLon: -86.0, tz: 'America/Mexico_City' },
  { minLat: -56.0, maxLat: -17.5, minLon: -76.0, maxLon: -66.0, tz: 'America/Santiago' },
  { minLat: 41.5, maxLat: 49.0, minLon: -117.5, maxLon: -111.0, tz: 'America/Boise' },
  { minLat: 32.0, maxLat: 49.0, minLon: -125.0, maxLon: -114.0, tz: 'America/Los_Angeles' },
  { minLat: 31.0, maxLat: 49.0, minLon: -114.0, maxLon: -103.0, tz: 'America/Denver' },
  { minLat: 25.0, maxLat: 49.0, minLon: -105.0, maxLon: -84.0, tz: 'America/Chicago' },
  { minLat: 24.0, maxLat: 48.0, minLon: -84.0, maxLon: -67.0, tz: 'America/New_York' },
  { minLat: 49.5, maxLat: 60.0, minLon: -8.5, maxLon: 2.0, tz: 'Europe/London' },
  { minLat: 41.5, maxLat: 51.5, minLon: -5.5, maxLon: 10.0, tz: 'Europe/Paris' },
]);

function pluralUnit(value, unit, language = 'es') {
  const word = UNIT_WORDS[language]?.[unit] || unit;
  return `${value} ${word}${value > 1 ? 's' : ''}`;
}

/**
 * Compute the exact UTC offset string (e.g. "-05:00", "+00:00", "+02:00") for a specific IANA timezone and instant.
 */
export function computeOffsetMinutes(timezone = DEFAULT_TIMEZONE, targetDate = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    });
    const parts = formatter.formatToParts(targetDate instanceof Date ? targetDate : new Date(targetDate));
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    if (tzPart?.value) {
      const match = tzPart.value.match(/GMT([+-]\d{2}:\d{2})/);
      if (match) return match[1];
      if (tzPart.value === 'GMT') return '+00:00';
    }
  } catch (err) {
    console.warn(`[time] failed to compute offset for ${timezone}:`, err.message);
  }
  return '-05:00';
}

/**
 * Convert local date/time components in a specified IANA timezone to a true UTC Date instance with exact DST resolution.
 */
export function zonedTimeToUtc(year, month, day, hour = 0, minute = 0, second = 0, timezone = DEFAULT_TIMEZONE) {
  try {
    const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(utcGuess);
    const p = {};
    for (const { type, value } of parts) {
      if (type !== 'literal') p[type] = parseInt(value, 10);
    }
    if (p.hour === 24) p.hour = 0;
    const localTimeInTz = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const offsetDiff = localTimeInTz - utcGuess.getTime();
    return new Date(utcGuess.getTime() - offsetDiff);
  } catch (err) {
    console.error(`[time] zonedTimeToUtc error for ${timezone}:`, err);
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  }
}

/**
 * Returns current local time as ISO 8601 with explicit offset.
 */
export function nowISO(timezone = DEFAULT_TIMEZONE) {
  const now = new Date();
  const offset = computeOffsetMinutes(timezone, now);
  try {
    const localStr = now.toLocaleString('sv-SE', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    return localStr.replace(' ', 'T') + offset;
  } catch (err) {
    console.error(`[time] nowISO error with timezone ${timezone}:`, err);
    return now.toISOString();
  }
}

/**
 * Returns current local time in human form.
 */
export function nowHuman(timezone = DEFAULT_TIMEZONE, language = 'es') {
  const intlLocale = language === 'en' ? 'en-US' : language === 'pt' ? 'pt-BR' : 'es-CO';
  try {
    return new Date().toLocaleString(intlLocale, {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (err) {
    console.error(`[time] nowHuman error with timezone ${timezone}:`, err);
    return new Date().toLocaleString();
  }
}

/**
 * Parse a targetTime string from the LLM or user into a UTC-anchored Date.
 * Supports relative offsets, full ISO dates, AM/PM 12h, and 24h formats with true timezone resolution.
 */
export function parseTargetTime(str, timezone = DEFAULT_TIMEZONE) {
  if (!str) return null;
  const s = String(str).trim();

  // 1. Relative offset format (e.g. "+10m", "in 15 minutes", "en 10 minutos", "en 2 horas")
  const relMatch = s.match(/^(?:\+?|in\s+|en\s+)?(\d+)\s*(m|min|mins|minuto|minutos|h|hr|hrs|hora|horas|d|d[ií]a|d[ií]as)$/i);
  if (relMatch) {
    const val = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    let ms = 0;
    if (unit.startsWith('m')) ms = val * 60 * 1000;
    else if (unit.startsWith('h')) ms = val * 60 * 60 * 1000;
    else if (unit.startsWith('d')) ms = val * 24 * 60 * 60 * 1000;
    return new Date(Date.now() + ms);
  }

  // Normalize dots in meridians (e.g. "p. m." -> "pm", "a. m." -> "am")
  let normalizedStr = s
    .replace(/p\.\s*m\./gi, 'pm')
    .replace(/a\.\s*m\./gi, 'am')
    .replace(/\s+/g, ' ')
    .trim();

  let isExplicitTomorrow = false;
  if (/^(?:mañana|tomorrow)(?:\s+(?:a\s+las?|at))?\s+/i.test(normalizedStr)) {
    isExplicitTomorrow = true;
    normalizedStr = normalizedStr.replace(/^(?:mañana|tomorrow)(?:\s+(?:a\s+las?|at))?\s+/i, '').trim();
  } else if (/^(?:hoy|today)(?:\s+(?:a\s+las?|at))?\s+/i.test(normalizedStr)) {
    normalizedStr = normalizedStr.replace(/^(?:hoy|today)(?:\s+(?:a\s+las?|at))?\s+/i, '').trim();
  }

  // Get current date components in the user's timezone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [todayYear, todayMonth, todayDay] = formatter.format(now).split('-').map(Number);

  // 2. Full Date + Time ISO or Date string (e.g. "2026-09-02T17:00:00Z", "2026-09-02 17:00", "2026-09-02T17:00:00-05:00")
  const fullIsoMatch = normalizedStr.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\s*(am|pm))?(?:([Zz])|([+-]\d{2}:?\d{2}))?$/i);
  if (fullIsoMatch) {
    const y = parseInt(fullIsoMatch[1], 10);
    const m = parseInt(fullIsoMatch[2], 10);
    const d = parseInt(fullIsoMatch[3], 10);
    let hh = fullIsoMatch[4] ? parseInt(fullIsoMatch[4], 10) : 12;
    const mm = fullIsoMatch[5] ? parseInt(fullIsoMatch[5], 10) : 0;
    const ss = fullIsoMatch[6] ? parseInt(fullIsoMatch[6], 10) : 0;
    const meridian = fullIsoMatch[7]?.toLowerCase();
    const hasZ = Boolean(fullIsoMatch[8]);
    const explicitOffset = fullIsoMatch[9];

    if (meridian === 'pm' && hh < 12) hh += 12;
    if (meridian === 'am' && hh === 12) hh = 0;

    if (hasZ) {
      return new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
    }
    if (explicitOffset) {
      return new Date(normalizedStr);
    }
    // No explicit offset -> interpret in user's timezone
    return zonedTimeToUtc(y, m, d, hh, mm, ss, timezone);
  }

  // 3. 12-hour AM/PM format (e.g. "5:00 PM", "5 PM", "06:30 am", "11 am", "5am")
  const ampmMatch = normalizedStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const minutes = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
    const meridian = ampmMatch[3].toLowerCase();
    if (meridian === 'pm' && hours < 12) hours += 12;
    if (meridian === 'am' && hours === 12) hours = 0;

    let targetUtc = zonedTimeToUtc(todayYear, todayMonth, todayDay, hours, minutes, 0, timezone);
    if (isExplicitTomorrow) {
      targetUtc = new Date(targetUtc.getTime() + 24 * 60 * 60 * 1000);
    } else if (targetUtc.getTime() <= Date.now()) {
      targetUtc = new Date(targetUtc.getTime() + 24 * 60 * 60 * 1000);
    }
    return targetUtc;
  }

  // 4. Time-only 24h format (e.g. "08:00", "18:30:00", "17:00")
  const timeOnlyMatch = normalizedStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (timeOnlyMatch) {
    const hours = parseInt(timeOnlyMatch[1], 10);
    const minutes = parseInt(timeOnlyMatch[2], 10);
    const seconds = timeOnlyMatch[3] ? parseInt(timeOnlyMatch[3], 10) : 0;

    let targetUtc = zonedTimeToUtc(todayYear, todayMonth, todayDay, hours, minutes, seconds, timezone);
    if (isExplicitTomorrow) {
      targetUtc = new Date(targetUtc.getTime() + 24 * 60 * 60 * 1000);
    } else if (targetUtc.getTime() <= Date.now()) {
      targetUtc = new Date(targetUtc.getTime() + 24 * 60 * 60 * 1000);
    }
    return targetUtc;
  }

  // 5. Explicit ISO string fallback
  const parsedDirect = new Date(normalizedStr);
  if (!isNaN(parsedDirect.getTime())) {
    return parsedDirect;
  }

  return null;
}

/**
 * Convert an ISO datetime into a human "in X minutes/hours/days/weeks" string.
 */
export function humanizeTimeUntil(targetDate, language = 'es') {
  const ms = targetDate.getTime() - Date.now();
  if (ms <= 0) {
    return {
      value: 0,
      unit: 'minutes',
      label: language === 'en' ? 'now' : language === 'pt' ? 'agora' : 'ahora',
    };
  }

  const minutes = Math.round(ms / (60 * 1000));
  if (minutes < 60) return { value: minutes, unit: 'minutes', label: pluralUnit(minutes, 'minutes', language) };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { value: hours, unit: 'hours', label: pluralUnit(hours, 'hours', language) };
  const days = Math.round(hours / 24);
  if (days < 14) return { value: days, unit: 'days', label: pluralUnit(days, 'days', language) };
  const weeks = Math.round(days / 7);
  return { value: weeks, unit: 'weeks', label: pluralUnit(weeks, 'weeks', language) };
}

export function formatLocalDateTime(date, timezone = DEFAULT_TIMEZONE, locale = 'es-CO') {
  try {
    return new Date(date).toLocaleString(locale, {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return new Date(date).toLocaleString();
  }
}

export function addMinutes(localStr, minutes, timezone = DEFAULT_TIMEZONE) {
  const offset = computeOffsetMinutes(timezone);
  const d = new Date(localStr + offset);
  d.setMinutes(d.getMinutes() + minutes);
  return formatLocalISO(d, timezone);
}

export function todayAt(localStr, hour, minute, timezone = DEFAULT_TIMEZONE) {
  const offset = computeOffsetMinutes(timezone);
  const d = new Date(localStr + offset);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return formatLocalISO(d, timezone);
}

export function formatLocalISO(d, timezone = DEFAULT_TIMEZONE) {
  return new Date(d).toLocaleString('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).replace(' ', 'T');
}

/**
 * Detect IANA timezone from phone number, BSUID or dialing code.
 */
export function detectTimezoneFromPhone(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return DEFAULT_TIMEZONE;
  const trimmed = rawPhone.trim();

  // 1. Meta BSUID ISO 3166-1 Alpha-2 resolution (e.g. "CO.1046858631495979", "MX.9999...")
  if (trimmed.includes('.')) {
    const isoCode = trimmed.split('.')[0]?.toUpperCase();
    if (isoCode && BSUID_COUNTRY_TIMEZONES[isoCode]) {
      return BSUID_COUNTRY_TIMEZONES[isoCode];
    }
    return DEFAULT_TIMEZONE;
  }

  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return DEFAULT_TIMEZONE;

  // 2. Direct E.164 Country Calling Codes
  for (const { prefix, tz } of COUNTRY_CALLING_CODES) {
    if (digits.startsWith(prefix)) return tz;
  }

  // 3. US / Canada (+1) Area Code resolution
  if (digits.startsWith('1') && digits.length >= 4) {
    const areaCode = digits.slice(1, 4);
    if (US_BOISE_CODES.has(areaCode)) return 'America/Boise';
    if (US_PACIFIC_CODES.has(areaCode)) return 'America/Los_Angeles';
    if (US_MOUNTAIN_CODES.has(areaCode)) return 'America/Denver';
    if (US_CENTRAL_CODES.has(areaCode)) return 'America/Chicago';
    if (US_EASTERN_CODES.has(areaCode)) return 'America/New_York';
    return 'America/New_York';
  }

  return DEFAULT_TIMEZONE;
}

/**
 * Detect IANA timezone from natural text mentioning cities or countries.
 */
export function detectTimezoneFromLocationText(text) {
  if (!text || typeof text !== 'string') return null;
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const item of CITY_LOCATION_MAP) {
    if (item.pattern.test(normalized)) return item.tz;
  }
  return null;
}

/**
 * Major Latin American and Global cities for instant reverse-geocoding (0.001ms).
 */
export const KNOWN_MAJOR_CITIES = Object.freeze([
  // Colombia
  { city: 'Bucaramanga', region: 'Santander', country: 'Colombia', lat: 7.1193, lon: -73.1227, tz: 'America/Bogota' },
  { city: 'Bogotá', region: 'Cundinamarca', country: 'Colombia', lat: 4.7110, lon: -74.0721, tz: 'America/Bogota' },
  { city: 'Medellín', region: 'Antioquia', country: 'Colombia', lat: 6.2442, lon: -75.5812, tz: 'America/Bogota' },
  { city: 'Cali', region: 'Valle del Cauca', country: 'Colombia', lat: 3.4516, lon: -76.5320, tz: 'America/Bogota' },
  { city: 'Barranquilla', region: 'Atlántico', country: 'Colombia', lat: 10.9685, lon: -74.7813, tz: 'America/Bogota' },
  { city: 'Cartagena', region: 'Bolívar', country: 'Colombia', lat: 10.3910, lon: -75.4794, tz: 'America/Bogota' },
  { city: 'Cúcuta', region: 'Norte de Santander', country: 'Colombia', lat: 7.8939, lon: -72.5078, tz: 'America/Bogota' },
  { city: 'Pereira', region: 'Risaralda', country: 'Colombia', lat: 4.8133, lon: -75.6961, tz: 'America/Bogota' },
  { city: 'Manizales', region: 'Caldas', country: 'Colombia', lat: 5.0689, lon: -75.5174, tz: 'America/Bogota' },
  { city: 'Santa Marta', region: 'Magdalena', country: 'Colombia', lat: 11.2408, lon: -74.1990, tz: 'America/Bogota' },
  { city: 'Ibagué', region: 'Tolima', country: 'Colombia', lat: 4.4389, lon: -75.2322, tz: 'America/Bogota' },
  { city: 'Villavicencio', region: 'Meta', country: 'Colombia', lat: 4.1420, lon: -73.6266, tz: 'America/Bogota' },
  { city: 'Pasto', region: 'Nariño', country: 'Colombia', lat: 1.2136, lon: -77.2811, tz: 'America/Bogota' },
  { city: 'Montería', region: 'Córdoba', country: 'Colombia', lat: 8.7479, lon: -75.8814, tz: 'America/Bogota' },
  { city: 'Neiva', region: 'Huila', country: 'Colombia', lat: 2.9273, lon: -75.2819, tz: 'America/Bogota' },
  { city: 'Armenia', region: 'Quindío', country: 'Colombia', lat: 4.5339, lon: -75.6811, tz: 'America/Bogota' },
  { city: 'Popayán', region: 'Cauca', country: 'Colombia', lat: 2.4448, lon: -76.6147, tz: 'America/Bogota' },
  { city: 'Valledupar', region: 'Cesar', country: 'Colombia', lat: 10.4631, lon: -73.2532, tz: 'America/Bogota' },

  // Mexico
  { city: 'Ciudad de México', region: 'CDMX', country: 'México', lat: 19.4326, lon: -99.1332, tz: 'America/Mexico_City' },
  { city: 'Guadalajara', region: 'Jalisco', country: 'México', lat: 20.6597, lon: -103.3496, tz: 'America/Mexico_City' },
  { city: 'Monterrey', region: 'Nuevo León', country: 'México', lat: 25.6866, lon: -100.3161, tz: 'America/Mexico_City' },
  { city: 'Cancún', region: 'Quintana Roo', country: 'México', lat: 21.1619, lon: -86.8515, tz: 'America/Cancun' },

  // Argentina
  { city: 'Buenos Aires', region: 'CABA', country: 'Argentina', lat: -34.6037, lon: -58.3816, tz: 'America/Argentina/Buenos_Aires' },
  { city: 'Córdoba', region: 'Córdoba', country: 'Argentina', lat: -31.4201, lon: -64.1888, tz: 'America/Argentina/Buenos_Aires' },
  { city: 'Rosario', region: 'Santa Fe', country: 'Argentina', lat: -32.9468, lon: -60.6393, tz: 'America/Argentina/Buenos_Aires' },

  // Spain
  { city: 'Madrid', region: 'Madrid', country: 'España', lat: 40.4168, lon: -3.7038, tz: 'Europe/Madrid' },
  { city: 'Barcelona', region: 'Cataluña', country: 'España', lat: 41.3851, lon: 2.1734, tz: 'Europe/Madrid' },
  { city: 'Valencia', region: 'Valencia', country: 'España', lat: 39.4699, lon: -0.3763, tz: 'Europe/Madrid' },

  // US
  { city: 'Miami', region: 'FL', country: 'EE. UU.', lat: 25.7617, lon: -80.1918, tz: 'America/New_York' },
  { city: 'Orlando', region: 'FL', country: 'EE. UU.', lat: 28.5383, lon: -81.3792, tz: 'America/New_York' },
  { city: 'Nueva York', region: 'NY', country: 'EE. UU.', lat: 40.7128, lon: -74.0060, tz: 'America/New_York' },
  { city: 'Los Ángeles', region: 'CA', country: 'EE. UU.', lat: 34.0522, lon: -118.2437, tz: 'America/Los_Angeles' },
  { city: 'Boise', region: 'ID', country: 'EE. UU.', lat: 43.6150, lon: -116.2023, tz: 'America/Boise' },
  { city: 'Houston', region: 'TX', country: 'EE. UU.', lat: 29.7604, lon: -95.3698, tz: 'America/Chicago' },
]);

/**
 * Find the nearest city name from GPS coordinates (Instant Reverse-Geocoding in 0.001ms).
 * @param {number} latitude
 * @param {number} longitude
 * @returns {{city: string, region: string, country: string, tz: string, distanceKm: number}|null}
 */
export function getNearestCityFromCoordinates(latitude, longitude) {
  if (latitude === undefined || longitude === undefined || latitude === null || longitude === null) return null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (isNaN(lat) || isNaN(lon)) return null;

  let bestMatch = null;
  let minDistanceSq = Infinity;

  for (const c of KNOWN_MAJOR_CITIES) {
    const dLat = lat - c.lat;
    const dLon = (lon - c.lon) * Math.cos((lat * Math.PI) / 180);
    const distSq = dLat * dLat + dLon * dLon;
    if (distSq < minDistanceSq) {
      minDistanceSq = distSq;
      bestMatch = c;
    }
  }

  const distanceKm = Math.round(Math.sqrt(minDistanceSq) * 111);
  if (bestMatch && distanceKm <= 250) {
    return { ...bestMatch, distanceKm };
  }

  return null;
}

/**
 * Detect IANA timezone from GPS coordinates.
 */
export function detectTimezoneFromCoordinates(latitude, longitude) {
  if (latitude === undefined || longitude === undefined || latitude === null || longitude === null) return null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (isNaN(lat) || isNaN(lon)) return null;

  // 1. Try nearest city match
  const nearest = getNearestCityFromCoordinates(lat, lon);
  if (nearest?.tz) return nearest.tz;

  // 2. Bounding box fallback
  for (const box of GPS_BOUNDING_BOXES) {
    if (lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon) {
      return box.tz;
    }
  }
  return null;
}
