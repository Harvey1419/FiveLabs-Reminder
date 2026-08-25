import { supabase } from './index.js';
import { detectTimezoneFromPhone } from '../utils/time.js';

// High-speed in-memory cache for user profiles (TTL: 10 minutes)
const userCache = new Map();
const USER_CACHE_TTL_MS = 10 * 60 * 1000;

export async function getOrCreateUserByPhone(phoneNumber, defaultTz = null, defaultLocale = 'es-CO', displayName = null) {
  const resolvedTz = defaultTz || (phoneNumber ? detectTimezoneFromPhone(phoneNumber) : 'America/Bogota');

  if (!phoneNumber) {
    return {
      id: null,
      phone_number: '',
      display_name: displayName,
      timezone: resolvedTz,
      locale: defaultLocale,
      created_at: new Date().toISOString(),
    };
  }

  const cleanPhone = String(phoneNumber).trim();
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
    userCache.set(data.phone_number, { user: data, timestamp: Date.now() });
  }

  return data;
}

export async function updateUserTimezone(userId, timezone) {
  if (!userId || !timezone) return null;
  return updateUserPreferences(userId, { timezone });
}
