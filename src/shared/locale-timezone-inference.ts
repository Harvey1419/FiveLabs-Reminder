import { DEFAULT_TIMEZONE } from './timezone-arithmetic.js';

export interface MajorCity { city: string; region: string; country: string; lat: number; lon: number; tz: string }

/**
 * Meta WhatsApp Business-Scoped User ID (BSUID) ISO 3166-1 alpha-2 mapping.
 */
export const BSUID_COUNTRY_TIMEZONES: Readonly<Record<string, string>> = Object.freeze({
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
export function detectLocaleFromPhone(rawPhone: unknown) {
  if (!rawPhone || typeof rawPhone !== 'string') return 'es-CO';
  const trimmed = rawPhone.trim();

  // 1. Meta BSUID ISO 3166-1 alpha-2 (e.g. "CO.123...", "US.123...", "BR.123...")
  if (trimmed.includes('.')) {
    const isoCode = trimmed.split('.')[0]?.toUpperCase();
    return SPANISH_BSUID_CODES.has(isoCode ?? '') ? 'es-CO' : 'en-US';
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
  // California
  '209', '213', '279', '310', '323', '341', '408', '415', '424', '442',
  '510', '530', '559', '562', '619', '626', '628', '650', '657', '661',
  '669', '707', '714', '747', '760', '805', '818', '820', '831', '858',
  '909', '916', '925', '949', '951',
  // Washington & Oregon
  '206', '253', '360', '425', '458', '503', '509', '541', '564', '971',
  // Nevada
  '702', '725', '775',
  // British Columbia (Canada)
  '236', '250', '604', '672', '778',
]);

const US_MOUNTAIN_CODES = new Set([
  // Colorado, Arizona, Utah, New Mexico, Montana, Wyoming
  '303', '719', '720', '970', '480', '520', '602', '623', '928',
  '385', '435', '801', '505', '575', '406', '307',
  // Alberta (Canada)
  '403', '587', '780', '825',
]);

const US_CENTRAL_CODES = new Set([
  // Texas
  '214', '254', '281', '325', '346', '361', '409', '430', '432', '469',
  '512', '713', '737', '806', '817', '830', '832', '903', '915', '936',
  '940', '956', '972', '979',
  // Illinois, Minnesota, Missouri, Wisconsin, Louisiana
  '217', '224', '309', '312', '331', '618', '630', '708', '773', '815', '847', '872',
  '218', '320', '507', '612', '651', '763', '952',
  '314', '417', '573', '636', '660', '816',
  '262', '414', '534', '608', '715', '920',
  '225', '318', '337', '504', '985',
  // Tennessee, Oklahoma, Kansas, Nebraska, Iowa, Arkansas, Alabama, Mississippi, Dakotas
  '615', '629', '731', '901', '931',
  '405', '539', '580', '918',
  '316', '620', '785', '913',
  '308', '402', '531',
  '319', '515', '563', '641', '712',
  '479', '501', '870',
  '205', '251', '256', '334', '938',
  '228', '601', '662', '769',
  '701', '605',
  // Manitoba, Saskatchewan (Canada)
  '204', '306', '431', '639',
]);

const US_EASTERN_CODES = new Set([
  // New York
  '212', '315', '332', '347', '516', '518', '585', '607', '631', '646',
  '680', '716', '718', '838', '845', '914', '917', '929', '934',
  // Florida
  '239', '305', '321', '352', '386', '407', '561', '689', '727', '754',
  '772', '786', '813', '850', '863', '904', '941', '954',
  // DC, Maryland, Virginia
  '202', '240', '301', '410', '443', '667',
  '276', '434', '540', '571', '703', '757', '804',
  // Georgia, Carolinas
  '229', '404', '470', '478', '678', '706', '762', '770', '912',
  '252', '336', '704', '743', '803', '828', '843', '854', '864', '910', '919', '980', '984',
  // Pennsylvania, New Jersey
  '201', '215', '223', '267', '272', '412', '484', '551', '570', '609',
  '610', '640', '717', '724', '732', '814', '848', '856', '862', '878', '908', '973',
  // New England
  '203', '207', '339', '351', '401', '413', '475', '508', '603', '617',
  '774', '781', '802', '857', '860', '959', '978',
  // Ohio, Michigan, Indiana
  '216', '220', '231', '234', '248', '260', '269', '313', '317', '330',
  '380', '419', '440', '463', '513', '517', '567', '574', '586', '614',
  '616', '734', '740', '765', '810', '812', '906', '930', '937', '947', '989',
  // Ontario, Quebec (Canada)
  '226', '249', '289', '343', '365', '416', '418', '437', '438', '450',
  '514', '519', '548', '579', '581', '613', '647', '705', '807', '819', '873', '905',
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



/**
 * Detect IANA timezone from phone number, BSUID or dialing code.
 */
export function detectTimezoneFromPhone(rawPhone: unknown) {
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
 * Check if a 3-digit area code is explicitly mapped in our North American Numbering Plan sets.
 */
export function isRecognizedNanpAreaCode(areaCode: unknown): boolean {
  if (!areaCode || typeof areaCode !== 'string') return false;
  return US_BOISE_CODES.has(areaCode)
    || US_PACIFIC_CODES.has(areaCode)
    || US_MOUNTAIN_CODES.has(areaCode)
    || US_CENTRAL_CODES.has(areaCode)
    || US_EASTERN_CODES.has(areaCode);
}

/**
 * Detect IANA timezone from natural text mentioning cities or countries.
 */
export function detectTimezoneFromLocationText(text: unknown): string | null {
  if (!text || typeof text !== 'string') return null;
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const item of CITY_LOCATION_MAP) {
    if (item.pattern.test(normalized)) return item.tz;
  }
  return null;
}

/**
 * Major Latin American and global cities for approximate local reverse-geocoding.
 */
export const KNOWN_MAJOR_CITIES: readonly MajorCity[] = Object.freeze([
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
 * Find the nearest catalogue city from GPS coordinates.
 * @param {number} latitude
 * @param {number} longitude
 * @returns {{city: string, region: string, country: string, tz: string, distanceKm: number}|null}
 */
export function getNearestCityFromCoordinates(latitude: unknown, longitude: unknown): (MajorCity & { distanceKm: number }) | null {
  if (latitude === undefined || longitude === undefined || latitude === null || longitude === null) return null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (isNaN(lat) || isNaN(lon)) return null;

  let bestMatch: MajorCity | null = null;
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
export function detectTimezoneFromCoordinates(latitude: unknown, longitude: unknown): string | null {
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
