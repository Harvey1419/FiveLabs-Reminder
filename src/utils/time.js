const DEFAULT_TIMEZONE = 'America/Bogota';

const UNIT_WORDS = {
  es: { minutes: 'minuto', hours: 'hora', days: 'día', weeks: 'semana' },
  en: { minutes: 'minute', hours: 'hour', days: 'day', weeks: 'week' },
  pt: { minutes: 'minuto', hours: 'hora', days: 'dia', weeks: 'semana' },
};

function pluralUnit(value, unit, language = 'es') {
  const word = UNIT_WORDS[language]?.[unit] || unit;
  return `${value} ${word}${value > 1 ? 's' : ''}`;
}

/**
 * Compute the UTC offset string (e.g. "-05:00", "+00:00") for a specific IANA timezone at the current instant.
 *
 * @param {string} [timezone='America/Bogota']
 * @returns {string}
 */
export function computeOffsetMinutes(timezone = DEFAULT_TIMEZONE) {
  try {
    const now = new Date();
    // Get formatted string in the target timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    });
    const parts = formatter.formatToParts(now);
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    if (tzPart && tzPart.value) {
      // E.g. "GMT-05:00" or "GMT+02:00" or "GMT"
      const match = tzPart.value.match(/GMT([+-]\d{2}:\d{2})/);
      if (match) return match[1];
      if (tzPart.value === 'GMT') return '+00:00';
    }
  } catch (err) {
    console.warn(`[time] failed to compute offset for ${timezone}:`, err.message);
  }

  // Fallback Colombia offset
  return '-05:00';
}

/**
 * Returns current local time as ISO 8601 with explicit offset, e.g. "2026-06-18T22:00:00-05:00".
 *
 * @param {string} [timezone='America/Bogota']
 * @returns {string}
 */
export function nowISO(timezone = DEFAULT_TIMEZONE) {
  const offset = computeOffsetMinutes(timezone);
  try {
    const localStr = new Date().toLocaleString('sv-SE', {
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
    return new Date().toISOString();
  }
}

/**
 * Returns current local time in human form, e.g. "miércoles 18 de junio, 22:00".
 *
 * @param {string} [timezone='America/Bogota']
 * @param {string} [language='es']
 * @returns {string}
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
 * Parse a targetTime string from the LLM into a UTC-anchored Date.
 * Accepts either ISO with offset ("2026-06-18T22:00:00-05:00") or naive ("2026-06-18T22:00:00").
 *
 * @param {string} str
 * @param {string} [timezone='America/Bogota']
 * @returns {Date|null}
 */
export function parseTargetTime(str, timezone = DEFAULT_TIMEZONE) {
  if (!str) return null;
  const s = String(str).trim();
  const offset = computeOffsetMinutes(timezone);

  // 1. Relative offset format (e.g. "+10m", "+10 min", "10m", "20m", "in 15 minutes", "en 10 minutos")
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

  // 2. 12-hour AM/PM format (e.g. "6:00 PM", "6 PM", "06:30 pm", "6:00 AM", "6 am")
  const ampmMatch = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const minutes = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
    const meridian = ampmMatch[3].toLowerCase();
    if (meridian === 'pm' && hours < 12) hours += 12;
    if (meridian === 'am' && hours === 12) hours = 0;
    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    const todayStr = new Date().toLocaleString('sv-SE', { timeZone: timezone }).slice(0, 10);
    const d = new Date(`${todayStr}T${hh}:${mm}:00${offset}`);
    if (!isNaN(d.getTime())) {
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
      return d;
    }
  }

  // 3. Time-only 24h format (e.g. "08:00", "18:30:00")
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) {
    const todayStr = new Date().toLocaleString('sv-SE', { timeZone: timezone }).slice(0, 10);
    let d = new Date(`${todayStr}T${s}${s.length <= 5 ? ':00' : ''}${offset}`);
    if (!isNaN(d.getTime())) {
      // Smart daytime heuristic: if "6:00" was given (6 AM passed), check if 18:00 (6 PM) is upcoming today
      const rawHour = parseInt(s.split(':')[0], 10);
      if (rawHour > 0 && rawHour <= 11 && d.getTime() <= Date.now()) {
        const pmHour = rawHour + 12;
        const pmTimeStr = `${String(pmHour).padStart(2, '0')}:${s.split(':')[1]}${s.length > 5 ? s.slice(5) : ':00'}`;
        const pmDate = new Date(`${todayStr}T${pmTimeStr}${offset}`);
        if (pmDate.getTime() > Date.now()) {
          return pmDate;
        }
      }
      if (d.getTime() <= Date.now()) {
        d.setDate(d.getDate() + 1);
      }
      return d;
    }
  }

  // 4. Already has explicit offset (Z or ±HH:mm)?
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  // 5. Naive ISO — treat as user's local timezone.
  const d = new Date(s + offset);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Convert an ISO datetime into a human "in X minutes/hours/days/weeks" string.
 *
 * @param {Date} targetDate
 * @param {string} [language='es']
 * @returns {{value: number, unit: string, label: string}}
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

/**
 * Format a timestamp for localized user-facing status.
 *
 * @param {Date|string|number} date
 * @param {string} [timezone='America/Bogota']
 * @param {string} [locale='es-CO']
 * @returns {string}
 */
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
 * Helper for relative time calculations in prompt construction.
 */
export function addMinutes(localStr, minutes, timezone = DEFAULT_TIMEZONE) {
  const offset = computeOffsetMinutes(timezone);
  const d = new Date(localStr + offset);
  d.setMinutes(d.getMinutes() + minutes);
  return formatLocalISO(d, timezone);
}

/**
 * Helper for absolute time today/tomorrow in prompt construction.
 */
export function todayAt(localStr, hour, minute, timezone = DEFAULT_TIMEZONE) {
  const offset = computeOffsetMinutes(timezone);
  const d = new Date(localStr + offset);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= Date.now()) {
    d.setDate(d.getDate() + 1);
  }
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
 * Detect IANA timezone from E.164 phone number prefix / area code.
 *
 * @param {string} rawPhone
 * @returns {string} IANA timezone
 */
export function detectTimezoneFromPhone(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return DEFAULT_TIMEZONE;
  const digits = rawPhone.replace(/\D/g, '');
  if (!digits) return DEFAULT_TIMEZONE;

  // Spain (+34)
  if (digits.startsWith('34')) return 'Europe/Madrid';
  // Colombia (+57)
  if (digits.startsWith('57')) return 'America/Bogota';
  // Argentina (+54)
  if (digits.startsWith('54')) return 'America/Argentina/Buenos_Aires';
  // Mexico (+52)
  if (digits.startsWith('52')) return 'America/Mexico_City';
  // Chile (+56)
  if (digits.startsWith('56')) return 'America/Santiago';
  // Peru (+51)
  if (digits.startsWith('51')) return 'America/Lima';
  // Ecuador (+593)
  if (digits.startsWith('593')) return 'America/Guayaquil';
  // Venezuela (+58)
  if (digits.startsWith('58')) return 'America/Caracas';
  // Brazil (+55)
  if (digits.startsWith('55')) return 'America/Sao_Paulo';
  // UK (+44)
  if (digits.startsWith('44')) return 'Europe/London';
  // France (+33)
  if (digits.startsWith('33')) return 'Europe/Paris';

  // US / Canada (+1)
  if (digits.startsWith('1') && digits.length >= 4) {
    const areaCode = digits.slice(1, 4);

    // Idaho / Boise
    if (['208', '986'].includes(areaCode)) return 'America/Boise';

    // Pacific US (CA, WA, OR, NV)
    if ([
      '206', '209', '213', '310', '323', '408', '415', '503', '509', '510',
      '530', '559', '562', '619', '626', '650', '661', '702', '707', '714',
      '760', '775', '805', '818', '831', '858', '909', '916', '925', '949',
      '951', '971'
    ].includes(areaCode)) return 'America/Los_Angeles';

    // Mountain US (CO, AZ, UT, NM, MT, WY)
    if ([
      '303', '719', '720', '970', '480', '520', '602', '623', '928', '801',
      '385', '505', '575', '406', '307'
    ].includes(areaCode)) return 'America/Denver';

    // Central US (IL, TX, MN, MO, etc.)
    if ([
      '214', '281', '469', '512', '713', '832', '972', '312', '773', '847',
      '630', '815', '612', '651', '763', '952', '314', '636', '816'
    ].includes(areaCode)) return 'America/Chicago';

    // Eastern US (NY, FL, MA, GA, DC, PA, NC, VA, etc.)
    if ([
      '212', '315', '516', '518', '585', '607', '631', '646', '716', '718',
      '845', '914', '917', '929', '305', '786', '954', '407', '813', '202',
      '404', '678', '617', '215', '267', '412', '703', '571', '919', '704',
      '410', '443'
    ].includes(areaCode)) return 'America/New_York';

    return 'America/New_York';
  }

  return DEFAULT_TIMEZONE;
}

/**
 * Detect IANA timezone from natural text mentioning cities, countries, or travel destinations.
 *
 * @param {string} text
 * @returns {string|null} IANA timezone or null
 */
export function detectTimezoneFromLocationText(text) {
  if (!text || typeof text !== 'string') return null;

  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const cityMap = [
    // Spain (Europe/Madrid)
    { pattern: /\b(madrid|barcelona|valencia|sevilla|espana|spain|malaga|bilbao|ibiza|mallorca|zaragoza)\b/i, tz: 'Europe/Madrid' },
    // Colombia (America/Bogota)
    { pattern: /\b(bogota|medellin|cali|barranquilla|cartagena|bucaramanga|pereira|manizales|colombia|santa marta)\b/i, tz: 'America/Bogota' },
    // Argentina (America/Argentina/Buenos_Aires)
    { pattern: /\b(buenos aires|caba|cordoba|rosario|mendoza|argentina|bariloche|la plata|mar del plata)\b/i, tz: 'America/Argentina/Buenos_Aires' },
    // Mexico (America/Mexico_City)
    { pattern: /\b(ciudad de mexico|cdmx|mexico city|guadalajara|monterrey|cancun|mexico|puebla|tijuana|queretaro)\b/i, tz: 'America/Mexico_City' },
    // Chile (America/Santiago)
    { pattern: /\b(santiago de chile|santiago|chile|valparaiso|concepcion|antofagasta)\b/i, tz: 'America/Santiago' },
    // US Eastern / Florida / NY
    { pattern: /\b(miami|orlando|nueva york|new york|nyc|boston|atlanta|washington|filadelfia|philadelphia|tampa)\b/i, tz: 'America/New_York' },
    // Idaho / Boise
    { pattern: /\b(boise|idaho)\b/i, tz: 'America/Boise' },
    // US Pacific
    { pattern: /\b(los angeles|san francisco|seattle|las vegas|california|san diego|portland)\b/i, tz: 'America/Los_Angeles' },
    // US Central
    { pattern: /\b(chicago|dallas|houston|austin|san antonio|texas)\b/i, tz: 'America/Chicago' },
    // US Mountain
    { pattern: /\b(denver|colorado|phoenix|salt lake city|arizona)\b/i, tz: 'America/Denver' },
    // Peru
    { pattern: /\b(lima|cusco|cuzco|arequipa|peru)\b/i, tz: 'America/Lima' },
    // UK
    { pattern: /\b(londres|london|reino unido|united kingdom|uk)\b/i, tz: 'Europe/London' },
    // France
    { pattern: /\b(paris|francia|france)\b/i, tz: 'Europe/Paris' },
    // Japan
    { pattern: /\b(tokio|tokyo|japon|japan)\b/i, tz: 'Asia/Tokyo' },
    // Brazil
    { pattern: /\b(sao paulo|rio de janeiro|brasil|brazil)\b/i, tz: 'America/Sao_Paulo' },
  ];

  for (const item of cityMap) {
    if (item.pattern.test(normalized)) {
      return item.tz;
    }
  }

  return null;
}

/**
 * Detect IANA timezone from GPS latitude/longitude coordinates (e.g. from WhatsApp location pin).
 *
 * @param {number} latitude
 * @param {number} longitude
 * @returns {string|null}
 */
export function detectTimezoneFromCoordinates(latitude, longitude) {
  if (latitude === undefined || longitude === undefined || latitude === null || longitude === null) return null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (isNaN(lat) || isNaN(lon)) return null;

  // Colombia: lat [-4.5, 13.5], lon [-79.5, -66.5]
  if (lat >= -4.5 && lat <= 13.5 && lon >= -79.5 && lon <= -66.5) return 'America/Bogota';

  // Spain: lat [35.0, 44.5], lon [-9.5, 4.5]
  if (lat >= 35.0 && lat <= 44.5 && lon >= -9.5 && lon <= 4.5) return 'Europe/Madrid';

  // Argentina: lat [-55.5, -21.5], lon [-74.0, -53.0]
  if (lat >= -55.5 && lat <= -21.5 && lon >= -74.0 && lon <= -53.0) return 'America/Argentina/Buenos_Aires';

  // Mexico: lat [14.0, 33.0], lon [-118.5, -86.0]
  if (lat >= 14.0 && lat <= 33.0 && lon >= -118.5 && lon <= -86.0) return 'America/Mexico_City';

  // Chile: lat [-56.0, -17.5], lon [-76.0, -66.0]
  if (lat >= -56.0 && lat <= -17.5 && lon >= -76.0 && lon <= -66.0) return 'America/Santiago';

  // Idaho / Boise: lat [41.5, 49.0], lon [-117.5, -111.0]
  if (lat >= 41.5 && lat <= 49.0 && lon >= -117.5 && lon <= -111.0) return 'America/Boise';

  // US Pacific: lat [32.0, 49.0], lon [-125.0, -114.0]
  if (lat >= 32.0 && lat <= 49.0 && lon >= -125.0 && lon <= -114.0) return 'America/Los_Angeles';

  // US Mountain: lat [31.0, 49.0], lon [-114.0, -103.0]
  if (lat >= 31.0 && lat <= 49.0 && lon >= -114.0 && lon <= -103.0) return 'America/Denver';

  // US Central: lat [25.0, 49.0], lon [-105.0, -84.0]
  if (lat >= 25.0 && lat <= 49.0 && lon >= -105.0 && lon <= -84.0) return 'America/Chicago';

  // US East: lat [24.0, 48.0], lon [-84.0, -67.0]
  if (lat >= 24.0 && lat <= 48.0 && lon >= -84.0 && lon <= -67.0) return 'America/New_York';

  // UK: lat [49.5, 60.0], lon [-8.5, 2.0]
  if (lat >= 49.5 && lat <= 60.0 && lon >= -8.5 && lon <= 2.0) return 'Europe/London';

  // France: lat [41.5, 51.5], lon [-5.5, 10.0]
  if (lat >= 41.5 && lat <= 51.5 && lon >= -5.5 && lon <= 10.0) return 'Europe/Paris';

  return null;
}
