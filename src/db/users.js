import { supabase } from './index.js';
import { detectTimezoneFromPhone } from '../utils/time.js';

// High-speed in-memory cache for user profiles (TTL: 10 minutes)
export const userCache = new Map();
const USER_CACHE_TTL_MS = 10 * 60 * 1000;

export function normalizeUserPhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const trimmed = phone.trim();
  // Check if BSUID (e.g. CO.1552339023039755)
  if (trimmed.includes('.') || trimmed.startsWith('CO.') || trimmed.startsWith('US.') || trimmed.startsWith('AR.')) {
    return trimmed;
  }
  const digits = trimmed.replace(/\D/g, '');
  return digits || trimmed;
}

export async function getOrCreateUserByPhone(phoneNumber, defaultTz = null, defaultLocale = 'es-CO', displayName = null) {
  const cleanPhone = normalizeUserPhone(phoneNumber);
  const resolvedTz = defaultTz || (cleanPhone ? detectTimezoneFromPhone(cleanPhone) : 'America/Bogota');

  if (!cleanPhone) {
    return {
      id: null,
      phone_number: '',
      display_name: displayName,
      timezone: resolvedTz,
      locale: defaultLocale,
      created_at: new Date().toISOString(),
    };
  }

  const cached = userCache.get(cleanPhone);
  if (cached && Date.now() - cached.timestamp < USER_CACHE_TTL_MS) {
    if (displayName && !cached.user.display_name) {
      cached.user.display_name = displayName;
      supabase.from('users').update({ display_name: displayName }).eq('id', cached.user.id).then(() => {}).catch(() => {});
    }
    return cached.user;
  }

  try {
    const { data: existingUser, error: selectError } = await supabase
      .from('users')
      .select('*')
      .eq('phone_number', cleanPhone)
      .maybeSingle();

    if (existingUser && !selectError) {
      if (displayName && !existingUser.display_name) {
        existingUser.display_name = displayName;
        await supabase.from('users').update({ display_name: displayName }).eq('id', existingUser.id);
      }
      userCache.set(cleanPhone, { user: existingUser, timestamp: Date.now() });
      return existingUser;
    }

    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert({
        phone_number: cleanPhone,
        display_name: displayName,
        timezone: resolvedTz,
        locale: defaultLocale,
      })
      .select()
      .single();

    if (newUser && !insertError) {
      userCache.set(cleanPhone, { user: newUser, timestamp: Date.now() });
      return newUser;
    }
  } catch (err) {
    console.error('getOrCreateUserByPhone threw:', err);
  }

  const fallbackUser = {
    id: null,
    phone_number: cleanPhone,
    display_name: displayName,
    timezone: resolvedTz,
    locale: defaultLocale,
    created_at: new Date().toISOString(),
  };
  userCache.set(cleanPhone, { user: fallbackUser, timestamp: Date.now() });
  return fallbackUser;
}

export async function updateUserPreferences(userId, { timezone, locale }) {
  if (!userId) return null;
  const updates = { updated_at: new Date().toISOString() };
  if (timezone) updates.timezone = timezone;
  if (locale) updates.locale = locale;

  const { data, error } = await supabase
    .from('users')
    .update(updates)
    .eq('id', userId)
    .select()
    .single();

  if (error) {
    console.error('updateUserPreferences failed:', error);
    return null;
  }

  // Invalidate cache
  if (data?.phone_number) {
    const cleanP = normalizeUserPhone(data.phone_number);
    userCache.set(cleanP, { user: data, timestamp: Date.now() });
  }

  return data;
}

export async function updateUserTimezone(userId, timezone) {
  if (!userId || !timezone) return null;
  return updateUserPreferences(userId, { timezone });
}

/**
 * Update the user's last inbound message timestamp to maintain 24-hour window status.
 * Updates both Postgres and in-memory userCache.
 *
 * @param {string} userId
 * @param {string} phoneNumber
 * @returns {Promise<void>}
 */
export async function touchUserLastActive(userId, phoneNumber) {
  const nowIso = new Date().toISOString();
  const cleanPhone = normalizeUserPhone(phoneNumber);

  // Update in-memory cache immediately for 0ms lookup
  if (cleanPhone) {
    const cached = userCache.get(cleanPhone);
    if (cached?.user) {
      cached.user.last_user_message_at = nowIso;
      cached.timestamp = Date.now();
    }
  }

  // Update Postgres asynchronously (non-blocking)
  if (userId) {
    supabase
      .from('users')
      .update({ last_user_message_at: nowIso, updated_at: nowIso })
      .eq('id', userId)
      .then(() => {})
      .catch((err) => console.warn('[users] touchUserLastActive failed:', err.message));
  } else if (cleanPhone) {
    supabase
      .from('users')
      .update({ last_user_message_at: nowIso, updated_at: nowIso })
      .eq('phone_number', cleanPhone)
      .then(() => {})
      .catch((err) => console.warn('[users] touchUserLastActive failed:', err.message));
  }
}

