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

export const SPANISH_CALLING_PREFIXES = Object.freeze([
  '34',  // España
  '57',  // Colombia
  '52',  // México
  '54',  // Argentina
  '56',  // Chile
  '51',  // Perú
  '593', // Ecuador
  '58',  // Venezuela
  '591', // Bolivia
  '598', // Uruguay
  '595', // Paraguay
  '506', // Costa Rica
  '507', // Panamá
  '502', // Guatemala
  '503', // El Salvador
  '504', // Honduras
  '505', // Nicaragua
  '53',  // Cuba
]);

export const SPANISH_BSUID_CODES = Object.freeze(new Set([
  'ES', 'CO', 'MX', 'AR', 'PE', 'CL', 'EC', 'VE', 'UY', 'PY', 'BO', 'CR', 'PA', 'GT', 'SV', 'HN', 'NI', 'CU', 'DO', 'PR'
]));

/**
 * Detect default locale ('es-CO' vs 'en-US') strictly based on the Hispanosphere domain.
 * Any phone or BSUID outside Spanish-speaking countries (including Brazil, Europe, North America, Asia)
 * defaults to English ('en-US') as the global lingua franca.
 */
export function detectLocaleFromPhone(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return 'es-CO';
  const trimmed = rawPhone.trim();

  // 1. Meta BSUID ISO 3166-1 alpha-2 (e.g. "CO.123...", "US.123...", "BR.123...")
  if (trimmed.includes('.')) {
    const isoCode = trimmed.split('.')[0]?.toUpperCase();
    return SPANISH_BSUID_CODES.has(isoCode) ? 'es-CO' : 'en-US';
  }

  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return 'es-CO';

  // 2. Spanish-speaking E.164 country prefixes
  const isSpanish = SPANISH_CALLING_PREFIXES.some(prefix => digits.startsWith(prefix));
  return isSpanish ? 'es-CO' : 'en-US';
}

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
      hourCycle: 'h23',
    });
    let candidate = utcGuess;

    // A single offset lookup is wrong when the naive UTC guess and the final
    // instant lie on opposite sides of a DST boundary. Re-evaluate the offset
    // at the candidate until it converges. Nonexistent wall clocks may
    // oscillate; callers that require strict validity round-trip the result.
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const parts = {};
      for (const { type, value } of formatter.formatToParts(candidate)) {
        if (type !== 'literal') parts[type] = Number(value);
      }
      const representedLocalTime = Date.UTC(
        parts.year, parts.month - 1, parts.day,
        parts.hour, parts.minute, parts.second,
      );
      const offsetAtCandidate = representedLocalTime - candidate.getTime();
      const next = new Date(utcGuess.getTime() - offsetAtCandidate);
      if (next.getTime() === candidate.getTime()) return next;
      candidate = next;
    }
    return candidate;
  } catch (err) {
    console.error(`[time] zonedTimeToUtc error for ${timezone}:`, err);
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  }
}

/**
 * Extract local date parts (year, month 1-12, day 1-31, dayOfWeek 0-6 Sun-Sat) in the given timezone.
 */
export function getLocalDateParts(dateObj = new Date(), timezone = DEFAULT_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  });
  const parts = formatter.formatToParts(dateObj instanceof Date ? dateObj : new Date(dateObj));
  const p = {};
  for (const { type, value } of parts) {
    p[type] = value;
  }
  const year = parseInt(p.year, 10);
  const month = parseInt(p.month, 10);
  const day = parseInt(p.day, 10);
  const dayOfWeekMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dayOfWeekMap[p.weekday] ?? 0;
  return { year, month, day, dayOfWeek };
}

/**
 * Move an instant by local calendar days while preserving its wall-clock time.
 * Unlike adding 24 hours, this remains correct across timezone DST changes.
 */
export function shiftZonedCalendarDays(dateObj, days, timezone = DEFAULT_TIMEZONE) {
  const date = dateObj instanceof Date ? dateObj : new Date(dateObj);
  const dayDelta = Number(days);
  if (Number.isNaN(date.getTime()) || !Number.isInteger(dayDelta)) return null;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const { type, value } of formatter.formatToParts(date)) {
    if (type !== 'literal') parts[type] = Number(value);
  }

  const shiftedCalendar = new Date(Date.UTC(
    parts.year, parts.month - 1, parts.day + dayDelta,
    parts.hour, parts.minute, parts.second,
  ));
  return zonedTimeToUtc(
    shiftedCalendar.getUTCFullYear(),
    shiftedCalendar.getUTCMonth() + 1,
    shiftedCalendar.getUTCDate(),
    shiftedCalendar.getUTCHours(),
    shiftedCalendar.getUTCMinutes(),
    shiftedCalendar.getUTCSeconds(),
    timezone,
  );
}

const MONTH_NAME_MAP = Object.freeze({
  enero: 1, enero_: 1, jan: 1, january: 1,
  febrero: 2, feb: 2, february: 2,
  marzo: 3, mar: 3, march: 3,
  abril: 4, apr: 4, april: 4,
  mayo: 5, may: 5,
  junio: 6, jun: 6, june: 6,
  julio: 7, jul: 7, july: 7,
  agosto: 8, aug: 8, august: 8,
  septiembre: 9, setiembre: 9, sep: 9, sept: 9, september: 9,
  octubre: 10, oct: 10, october: 10,
  noviembre: 11, nov: 11, november: 11,
  diciembre: 12, dec: 12, december: 12,
});

/**
 * Resolves structured Google Calendar temporal scope into exact deterministic bounds.
 *
 * @param {object} [params]
 * @param {string} [params.scope] - 'today'|'tomorrow'|'this_week'|'next_week'|'this_weekend'|'default_upcoming'|'next_event'|'explicit_date'|'explicit_range'|'month'
 * @param {string} [params.date] - 'YYYY-MM-DD' or date string
 * @param {string} [params.dateFrom] - 'YYYY-MM-DD'
 * @param {string} [params.dateTo] - 'YYYY-MM-DD'
 * @param {string|number} [params.month] - '10' or 'octubre'
 * @param {string} [params.timeMin] - Fallback string
 * @param {string} [params.timeMax] - Fallback string
 * @param {string} [timezone=DEFAULT_TIMEZONE]
 * @param {Date} [now=new Date()]
 * @returns {{ timeMin: Date, timeMax: Date|null, isNextEvent: boolean, maxResults: number, scope: string }}
 */
export function resolveCalendarTemporalScope(params = {}, timezone = DEFAULT_TIMEZONE, now = new Date()) {
  const { year, month, day, dayOfWeek } = getLocalDateParts(now, timezone);

  // Normalize requested scope or infer from parameters
  let scope = params.scope ? String(params.scope).toLowerCase().trim() : null;
  const rawMin = params.timeMin ? String(params.timeMin).toLowerCase().trim() : null;
  const rawMax = params.timeMax ? String(params.timeMax).toLowerCase().trim() : null;

  const WEEKDAY_MAP = {
    'domingo': 0, 'sunday': 0, 'sun': 0,
    'lunes': 1, 'monday': 1, 'mon': 1,
    'martes': 2, 'tuesday': 2, 'tue': 2,
    'miercoles': 3, 'miércoles': 3, 'wednesday': 3, 'wed': 3,
    'jueves': 4, 'thursday': 4, 'thu': 4,
    'viernes': 5, 'friday': 5, 'fri': 5,
    'sabado': 6, 'sábado': 6, 'saturday': 6, 'sat': 6,
  };

  const WEEKDAY_NAME_REV = {
    0: 'sunday', 1: 'monday', 2: 'tuesday', 3: 'wednesday', 4: 'thursday', 5: 'friday', 6: 'saturday'
  };

  if (scope && /^\d{4}-\d{2}-\d{2}/.test(scope)) {
    if (!params.date) params.date = scope;
    scope = 'explicit_date';
  }

  // Check if scope, date, or query is a weekday name (e.g. "viernes", "el viernes", "este viernes", "friday")
  const checkWeekdayStr = (str) => {
    if (!str) return null;
    const clean = String(str).toLowerCase().trim()
      .replace(/^(?:el|este|este\s+próximo|este\s+proximo|el\s+próximo|el\s+proximo)\s+/i, '')
      .replace(/\s+/g, '');
    if (WEEKDAY_MAP[clean] !== undefined) return WEEKDAY_MAP[clean];
    // Check inside string
    for (const [name, val] of Object.entries(WEEKDAY_MAP)) {
      if (clean === name || clean.startsWith(name)) return val;
    }
    return null;
  };

  const matchedWeekday = checkWeekdayStr(scope) ?? checkWeekdayStr(params.date) ?? checkWeekdayStr(params.query) ?? checkWeekdayStr(rawMin);

  if (matchedWeekday !== null) {
    const isNext = Boolean(
      (scope && (scope.includes('proximo') || scope.includes('próximo') || scope.includes('next'))) ||
      (params.query && (params.query.includes('proximo') || params.query.includes('próximo') || params.query.includes('next')))
    );
    let diff = (matchedWeekday - dayOfWeek + 7) % 7;
    if (diff === 0 && isNext) {
      diff = 7;
    }
    const timeMin = zonedTimeToUtc(year, month, day + diff, 0, 0, 0, timezone);
    const timeMax = zonedTimeToUtc(year, month, day + diff + 1, 0, 0, 0, timezone);
    const canonicalScope = WEEKDAY_NAME_REV[matchedWeekday] || 'weekday';
    return { timeMin, timeMax, isNextEvent: false, maxResults: 25, scope: canonicalScope };
  }

  if (!scope) {
    if (rawMin === 'hoy' || rawMin === 'today') scope = 'today';
    else if (rawMin === 'mañana' || rawMin === 'tomorrow') scope = 'tomorrow';
    else if (rawMin === 'pasado_mañana' || rawMin === 'pasado_manana' || rawMin === 'pasado mañana' || rawMin === 'day_after_tomorrow') scope = 'day_after_tomorrow';
    else if (rawMin === 'esta_semana' || rawMin === 'this_week') scope = 'this_week';
    else if (rawMin === 'proxima_semana' || rawMin === 'next_week') scope = 'next_week';
    else if (rawMin === 'este_fin_de_semana' || rawMin === 'this_weekend') scope = 'this_weekend';
    else if (rawMin === 'proximo' || rawMin === 'next_event' || rawMin === 'mas_cercano' || rawMin === 'closest') scope = 'next_event';
    else if (params.dateFrom && params.dateTo) scope = 'explicit_range';
    else if (params.date || (rawMin && /^\d{4}-\d{2}-\d{2}/.test(rawMin))) scope = 'explicit_date';
    else if (params.month) scope = 'month';
    else if (rawMin === 'este_ano' || rawMin === 'este_año' || rawMin === 'this_year' || rawMin === 'full_year') scope = 'full_year';
    else if (rawMin === 'resto_del_ano' || rawMin === 'resto_del_año' || rawMin === 'remaining_year') scope = 'remaining_year';
    else if (rawMin === 'todos' || rawMin === 'pendientes' || rawMin === 'upcoming' || rawMin === 'all') scope = 'upcoming';
    else if (rawMin && rawMax) scope = 'custom_range';
    else if (rawMin) scope = 'from_time';
    else scope = 'default_upcoming';
  }

  switch (scope) {
    case 'upcoming':
    case 'all':
    case 'all_pending':
    case 'todos':
    case 'pendientes':
    case 'todos_los_pendientes': {
      // From now until the end of next month / year (covers all upcoming items in chronological order)
      const timeMin = now;
      const timeMax = zonedTimeToUtc(year + 1, 1, 1, 0, 0, 0, timezone);
      return { timeMin, timeMax, isNextEvent: false, maxResults: 50, scope: 'upcoming' };
    }

    case 'today':
    case 'hoy': {
      const timeMin = zonedTimeToUtc(year, month, day, 0, 0, 0, timezone);
      const timeMax = zonedTimeToUtc(year, month, day + 1, 0, 0, 0, timezone);
      return { timeMin, timeMax, isNextEvent: false, maxResults: 15, scope: 'today' };
    }

    case 'remaining_today':
    case 'rest_of_today':
    case 'lo_que_queda_de_hoy': {
      const timeMin = now;
      const timeMax = zonedTimeToUtc(year, month, day + 1, 0, 0, 0, timezone);
      return { timeMin, timeMax, isNextEvent: false, maxResults: 15, scope: 'remaining_today' };
    }

    case 'tomorrow':
    case 'mañana': {
      const timeMin = zonedTimeToUtc(year, month, day + 1, 0, 0, 0, timezone);
      const timeMax = zonedTimeToUtc(year, month, day + 2, 0, 0, 0, timezone);
      return { timeMin, timeMax, isNextEvent: false, maxResults: 15, scope: 'tomorrow' };
    }

    case 'day_after_tomorrow':
    case 'pasado_mañana':
    case 'pasado_manana':
    case 'pasado mañana': {
      const timeMin = zonedTimeToUtc(year, month, day + 2, 0, 0, 0, timezone);
      const timeMax = zonedTimeToUtc(year, month, day + 3, 0, 0, 0, timezone);
      return { timeMin, timeMax, isNextEvent: false, maxResults: 15, scope: 'day_after_tomorrow' };
    }

    case 'this_week':
    case 'esta_semana': {
      // Hermes week starts on Monday (dayOfWeek = 1). Sunday is dayOfWeek = 0.
      const distToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const distToNextMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
      const timeMin = zonedTimeToUtc(year, month, day - distToMonday, 0, 0, 0, timezone);
      const timeMax = zonedTimeToUtc(year, month, day + distToNextMonday, 0, 0, 0, timezone);
      return { timeMin, timeMax, isNextEvent: false, maxResults: 25, scope: 'this_week' };
    }

    case 'next_week':
    case 'proxima_semana': {
      const distToNextMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
      const distToMondayAfterNext = dayOfWeek === 0 ? 8 : 15 - dayOfWeek;
      const timeMin = zonedTimeToUtc(year, month, day + distToNextMonday, 0, 0, 0, timezone);
      const timeMax = zonedTimeToUtc(year, month, day + distToMondayAfterNext, 0, 0, 0, timezone);
      return { timeMin, timeMax, isNextEvent: false, maxResults: 25, scope: 'next_week' };
    }

    case 'this_weekend':
    case 'este_fin_de_semana': {
      // Viernes: sábado mañana a lunes. Sábado: sábado hoy a lunes. Domingo: domingo hoy a lunes. Lunes-Jueves: próximo sábado a lunes.
      let startOffset = 0;
      let endOffset = 0;
      if (dayOfWeek === 5) {
        startOffset = 1;
        endOffset = 3;
      } else if (dayOfWeek === 6) {
        startOffset = 0;
        endOffset = 2;
      } else if (dayOfWeek === 0) {
        startOffset = 0;
        endOffset = 1;
      } else {
        startOffset = 6 - dayOfWeek;
        endOffset = 8 - dayOfWeek;
      }
      const timeMin = zonedTimeToUtc(year, month, day + startOffset, 0, 0, 0, timezone);
      const timeMax = zonedTimeToUtc(year, month, day + endOffset, 0, 0, 0, timezone);
      return { timeMin, timeMax, isNextEvent: false, maxResults: 20, scope: 'this_weekend' };
    }

    case 'next_event':
    case 'proximo':
    case 'mas_cercano':
    case 'closest': {
      // Sole documented exception: singleEvents=true, orderBy=startTime, maxResults=1 with timeMin=now, timeMax=null
      return { timeMin: now, timeMax: null, isNextEvent: true, maxResults: 1, scope: 'next_event' };
    }

    case 'explicit_date': {
      const targetStr = String(params.date || params.timeMin || '').trim();
      let targetYear = year;
      let targetMonth = month;
      let targetDay = day;

      const dateMatch = targetStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (dateMatch) {
        targetYear = parseInt(dateMatch[1], 10);
        targetMonth = parseInt(dateMatch[2], 10);
        targetDay = parseInt(dateMatch[3], 10);
      } else {
        const naturalMatch = targetStr.match(/^(\d{1,2})\s+de\s+([a-záéíóúñ]+)(?:\s+de\s+(\d{4}))?/i);
        if (naturalMatch) {
          targetDay = parseInt(naturalMatch[1], 10);
          const mName = naturalMatch[2].toLowerCase();
          targetMonth = MONTH_NAME_MAP[mName] || month;
          if (naturalMatch[3]) {
            targetYear = parseInt(naturalMatch[3], 10);
          } else if (targetMonth < month) {
            targetYear += 1;
          }
        } else {
          const parsed = parseTargetTime(targetStr, timezone);
          if (parsed) {
            const parts = getLocalDateParts(parsed, timezone);
            targetYear = parts.year;
            targetMonth = parts.month;
            targetDay = parts.day;
          }
        }
      }

      const timeMin = zonedTimeToUtc(targetYear, targetMonth, targetDay, 0, 0, 0, timezone);
      const timeMax = zonedTimeToUtc(targetYear, targetMonth, targetDay + 1, 0, 0, 0, timezone);
      return { timeMin, timeMax, isNextEvent: false, maxResults: 20, scope: 'explicit_date' };
    }

    case 'explicit_range': {
      const fromStr = String(params.dateFrom || params.timeMin || '').trim();
      const toStr = String(params.dateTo || params.timeMax || '').trim();

      let fromY = year, fromM = month, fromD = day;
      let toY = year, toM = month, toD = day;

      const matchFrom = fromStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (matchFrom) {
        fromY = parseInt(matchFrom[1], 10);
        fromM = parseInt(matchFrom[2], 10);
        fromD = parseInt(matchFrom[3], 10);
      } else {
        const p = parseTargetTime(fromStr, timezone);
        if (p) {
          const parts = getLocalDateParts(p, timezone);
          fromY = parts.year; fromM = parts.month; fromD = parts.day;
        }
      }

      const matchTo = toStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (matchTo) {
        toY = parseInt(matchTo[1], 10);
        toM = parseInt(matchTo[2], 10);
        toD = parseInt(matchTo[3], 10);
      } else {
        const p = parseTargetTime(toStr, timezone);
        if (p) {
          const parts = getLocalDateParts(p, timezone);
          toY = parts.year; toM = parts.month; toD = parts.day;
        }
      }

      const timeMin = zonedTimeToUtc(fromY, fromM, fromD, 0, 0, 0, timezone);
      const timeMax = zonedTimeToUtc(toY, toM, toD + 1, 0, 0, 0, timezone);
      return { timeMin, timeMax, isNextEvent: false, maxResults: 35, scope: 'explicit_range' };
    }

    case 'month': {
      const rawMonthStr = String(params.month || '').toLowerCase().trim();
      let targetMonthNum = MONTH_NAME_MAP[rawMonthStr] || parseInt(rawMonthStr, 10);
      if (!targetMonthNum || isNaN(targetMonthNum) || targetMonthNum < 1 || targetMonthNum > 12) {
        targetMonthNum = month;
      }
      let targetYearNum = year;
      if (targetMonthNum < month) {
        targetYearNum += 1;
      }
      const timeMin = zonedTimeToUtc(targetYearNum, targetMonthNum, 1, 0, 0, 0, timezone);
      const timeMax = zonedTimeToUtc(targetYearNum, targetMonthNum + 1, 1, 0, 0, 0, timezone);
      return { timeMin, timeMax, isNextEvent: false, maxResults: 50, scope: 'month' };
    }

    case 'full_year':
    case 'este_ano':
    case 'este_año':
    case 'todo_el_ano':
    case 'todo_el_año':
    case 'this_year': {
      // 01 de enero 00:00 local -> 01 de enero del siguiente año 00:00 local
      const timeMin = zonedTimeToUtc(year, 1, 1, 0, 0, 0, timezone);
      const timeMax = zonedTimeToUtc(year + 1, 1, 1, 0, 0, 0, timezone);
      return { timeMin, timeMax, isNextEvent: false, maxResults: 50, scope: 'full_year' };
    }

    case 'remaining_year':
    case 'resto_del_ano':
    case 'resto_del_año':
    case 'lo_que_queda_del_ano':
    case 'lo_que_queda_del_año': {
      // now -> 01 de enero del siguiente año 00:00 local
      const timeMin = now;
      const timeMax = zonedTimeToUtc(year + 1, 1, 1, 0, 0, 0, timezone);
      return { timeMin, timeMax, isNextEvent: false, maxResults: 50, scope: 'remaining_year' };
    }

    case 'custom_range': {
      const timeMin = parseTargetTime(params.timeMin, timezone) || now;
      const timeMax = parseTargetTime(params.timeMax, timezone) || zonedTimeToUtc(year, month, day + 15, 0, 0, 0, timezone);
      return { timeMin, timeMax, isNextEvent: false, maxResults: 30, scope: 'custom_range' };
    }

    case 'from_time': {
      const timeMin = parseTargetTime(params.timeMin, timezone) || now;
      const distToMondayAfterNext = dayOfWeek === 0 ? 8 : 15 - dayOfWeek;
      const timeMax = zonedTimeToUtc(year, month, day + distToMondayAfterNext, 0, 0, 0, timezone);
      return { timeMin, timeMax, isNextEvent: false, maxResults: 20, scope: 'from_time' };
    }

    case 'default_upcoming':
    default: {
      // Default: now -> start of Monday after next week (covers now through next Sunday 23:59:59.999 + 1ms)
      const distToMondayAfterNext = dayOfWeek === 0 ? 8 : 15 - dayOfWeek;
      const timeMin = now;
      const timeMax = zonedTimeToUtc(year, month, day + distToMondayAfterNext, 0, 0, 0, timezone);
      return { timeMin, timeMax, isNextEvent: false, maxResults: 20, scope: 'default_upcoming' };
    }
  }
}

/**
 * Compute exact semi-open time bounds [timeMin, timeMax) for a local day in the given timezone.
 *
 * @param {'today'|'tomorrow'|'hoy'|'mañana'|string|Date} [target='today']
 * @param {string} [timezone=DEFAULT_TIMEZONE]
 * @returns {{ timeMin: Date, timeMax: Date }}
 */
export function getDayBounds(target = 'today', timezone = DEFAULT_TIMEZONE) {
  const t = String(target || 'today').toLowerCase().trim();
  const isDate = /^\d{4}-\d{2}-\d{2}/.test(t);
  const resolved = resolveCalendarTemporalScope(
    isDate ? { scope: 'explicit_date', date: t } : { scope: t },
    timezone
  );
  return { timeMin: resolved.timeMin, timeMax: resolved.timeMax };
}

/**
 * Returns current local time as ISO 8601 with explicit offset.
 */
export function nowISO(timezone = DEFAULT_TIMEZONE, referenceTime = new Date()) {
  const requestedReference = referenceTime instanceof Date ? referenceTime : new Date(referenceTime);
  const now = Number.isNaN(requestedReference.getTime()) ? new Date() : requestedReference;
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
export function nowHuman(timezone = DEFAULT_TIMEZONE, language = 'es', referenceTime = new Date()) {
  const intlLocale = language === 'en' ? 'en-US' : language === 'pt' ? 'pt-BR' : 'es-CO';
  const requestedReference = referenceTime instanceof Date ? referenceTime : new Date(referenceTime);
  const now = Number.isNaN(requestedReference.getTime()) ? new Date() : requestedReference;
  try {
    return now.toLocaleString(intlLocale, {
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
 * Parse a targetTime string from the LLM or a legacy caller into a UTC-anchored Date.
 * The canonical LLM contract is language-independent:
 * - ISO 8601 duration for relative time (PT2M, PT3H, P1D, P1W)
 * - ISO 8601 date/time for an absolute time
 * Natural-language forms remain below only for backwards compatibility.
 */
export function parseTargetTime(str, timezone = DEFAULT_TIMEZONE, referenceTime = new Date(), options = {}) {
  if (!str) return null;
  const s = String(str).trim();
  const requestedReference = referenceTime == null
    ? new Date()
    : (referenceTime instanceof Date ? referenceTime : new Date(referenceTime));
  const referenceDate = Number.isNaN(requestedReference.getTime()) ? new Date() : requestedReference;

  // 1. Canonical relative time. Months and years are deliberately unsupported
  // because their duration is calendar-dependent; the LLM must resolve those
  // into an absolute ISO date/time instead.
  const durationMatch = s.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i);
  if (durationMatch && durationMatch.slice(1).some((part) => part !== undefined)) {
    const weeks = Number(durationMatch[1] || 0);
    const days = Number(durationMatch[2] || 0);
    const hours = Number(durationMatch[3] || 0);
    const minutes = Number(durationMatch[4] || 0);
    const durationMs = (
      weeks * 7 * 24 * 60 * 60 * 1000
      + days * 24 * 60 * 60 * 1000
      + hours * 60 * 60 * 1000
      + minutes * 60 * 1000
    );
    if (durationMs > 0 && Number.isSafeInteger(durationMs)) {
      return new Date(referenceDate.getTime() + durationMs);
    }
    return null;
  }

  // Legacy compatibility only. Do not extend this into a language catalogue:
  // native LLM tools must emit the canonical ISO contract above.
  // Examples: "+10m", "in 15 minutes", "en 10 minutos", "dentro de 2 horas".
  const relMatch = s.match(/^(?:\+?|in\s+|en\s+|dentro\s+de\s+)?(\d+)\s*(m|min|mins|minute|minutes|minuto|minutos|h|hr|hrs|hour|hours|hora|horas|d|day|days|d[ií]a|d[ií]as|w|week|weeks|semana|semanas)$/i);
  if (relMatch) {
    const val = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    let ms = 0;
    if (['m', 'min', 'mins', 'minute', 'minutes', 'minuto', 'minutos'].includes(unit)) {
      ms = val * 60 * 1000;
    } else if (['h', 'hr', 'hrs', 'hour', 'hours', 'hora', 'horas'].includes(unit)) {
      ms = val * 60 * 60 * 1000;
    } else if (['d', 'day', 'days', 'día', 'días'].includes(unit)) {
      ms = val * 24 * 60 * 60 * 1000;
    } else if (['w', 'week', 'weeks', 'semana', 'semanas'].includes(unit)) {
      ms = val * 7 * 24 * 60 * 60 * 1000;
    }
    return new Date(referenceDate.getTime() + ms);
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
  const now = referenceDate;
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
    } else if (options.rollForwardTimeOnly !== false && targetUtc.getTime() <= referenceDate.getTime()) {
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
    } else if (options.rollForwardTimeOnly !== false && targetUtc.getTime() <= referenceDate.getTime()) {
      targetUtc = new Date(targetUtc.getTime() + 24 * 60 * 60 * 1000);
    }
    return targetUtc;
  }

  // 4.5. Natural Date in Spanish/English format (e.g. "9 de septiembre", "el 9 de septiembre de 2026", "4 de septiembre a las 10:00 am", "September 9 at 5pm")
  const naturalDateMatch = normalizedStr.match(/^(?:el\s+)?(\d{1,2})\s+de\s+([a-záéíóúñ]+)(?:\s+de\s+(\d{4}))?(?:\s+(?:a\s+las?|at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (naturalDateMatch) {
    const d = parseInt(naturalDateMatch[1], 10);
    const monthName = naturalDateMatch[2].toLowerCase();
    const monthNum = MONTH_NAME_MAP[monthName] || todayMonth;
    let y = naturalDateMatch[3] ? parseInt(naturalDateMatch[3], 10) : todayYear;
    if (!naturalDateMatch[3] && monthNum < todayMonth) {
      y += 1;
    }
    let hh = naturalDateMatch[4] ? parseInt(naturalDateMatch[4], 10) : 9;
    const mm = naturalDateMatch[5] ? parseInt(naturalDateMatch[5], 10) : 0;
    const meridian = naturalDateMatch[6]?.toLowerCase();
    if (meridian === 'pm' && hh < 12) hh += 12;
    if (meridian === 'am' && hh === 12) hh = 0;
    return zonedTimeToUtc(y, monthNum, d, hh, mm, 0, timezone);
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

/**
 * Format a Date or ISO string into a human-friendly natural date & 12-hour time string.
 * Examples:
 * - "Hoy a las 8:45 PM"
 * - "Mañana a las 8:00 AM"
 * - "Viernes, 4 de septiembre a las 10:00 AM"
 * - In English: "Today at 8:45 PM", "Tomorrow at 8:00 AM", "Friday, September 4 at 10:00 AM"
 *
 * @param {string|Date} date
 * @param {string} [timezone=DEFAULT_TIMEZONE]
 * @param {string} [language='es']
 * @returns {string}
 */
export function formatHumanFriendlyDateTime(date, timezone = DEFAULT_TIMEZONE, language = 'es') {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return String(date);

  const now = new Date();

  // Get local date string for target date and current date
  const targetDateStr = d.toLocaleDateString('en-CA', { timeZone: timezone }); // 'YYYY-MM-DD'
  const nowDateStr = now.toLocaleDateString('en-CA', { timeZone: timezone });

  // Calculate tomorrow local date string
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowDateStr = tomorrow.toLocaleDateString('en-CA', { timeZone: timezone });

  // Format 12h time (e.g. "8:45 PM" or "8:45 AM")
  const time12 = d.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const isEs = !language || !language.startsWith('en');

  if (targetDateStr === nowDateStr) {
    return isEs ? `Hoy a las ${time12}` : `Today at ${time12}`;
  }

  if (targetDateStr === tomorrowDateStr) {
    return isEs ? `Mañana a las ${time12}` : `Tomorrow at ${time12}`;
  }

  // For future/past dates, format as "Día, D de mes a las HH:MM AM/PM"
  if (isEs) {
    const weekday = d.toLocaleDateString('es-CO', { timeZone: timezone, weekday: 'long' });
    const dayNum = d.toLocaleDateString('es-CO', { timeZone: timezone, day: 'numeric' });
    const monthName = d.toLocaleDateString('es-CO', { timeZone: timezone, month: 'long' });
    const capitalizedWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
    return `${capitalizedWeekday}, ${dayNum} de ${monthName} a las ${time12}`;
  } else {
    const weekday = d.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long' });
    const monthName = d.toLocaleDateString('en-US', { timeZone: timezone, month: 'long' });
    const dayNum = d.toLocaleDateString('en-US', { timeZone: timezone, day: 'numeric' });
    return `${weekday}, ${monthName} ${dayNum} at ${time12}`;
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
