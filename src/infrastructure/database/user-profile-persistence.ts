import { domainErrorMessage,type DomainStorageError,type UserProfileRow,type UserPersistenceClient } from './profile-integration-client.js';
export interface UserCacheEntry { user: UserProfileRow; timestamp: number }
export class UserProfileCache extends Map<string,UserCacheEntry> { readonly del = this.delete.bind(this); }
export interface UserPreferences { timezone?: string; locale?: string }
export interface UserProfileHelpers { detectTimezoneFromPhone(phone: string): string; detectLocaleFromPhone(phone: string): string }
function objectError(error: unknown): DomainStorageError {
  const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return { ...(code ? { code } : {}),...(domainErrorMessage(error) ? { message: domainErrorMessage(error)! } : {}) };
}
/** Shared-client access is lazy; the host supplies locale/timezone inference and ambient transport. */
export function createUserProfilePersistence(getClient: () => UserPersistenceClient,helpers: UserProfileHelpers) {
  const { detectTimezoneFromPhone,detectLocaleFromPhone } = helpers;
  // High-speed in-memory cache for user profiles (TTL: 15 minutes)
  const userCache = new UserProfileCache();
  const USER_CACHE_TTL_MS = 15 * 60 * 1000;

  function normalizeUserPhone(phone: unknown) {
    if (!phone || typeof phone !== 'string') return '';
    const trimmed = phone.trim();
    // Check if BSUID (e.g. CO.1552339023039755)
    if (trimmed.includes('.') || trimmed.startsWith('CO.') || trimmed.startsWith('US.') || trimmed.startsWith('AR.')) {
      return trimmed;
    }
    const digits = trimmed.replace(/\D/g, '');
    return digits || trimmed;
  }

  async function getOrCreateUserByPhone(phoneNumber: string, defaultTz: string | null = null, defaultLocale = 'es-CO', displayName: string | null = null, { fresh = false }: { fresh?: boolean } = {}) {
    const cleanPhone = normalizeUserPhone(phoneNumber);
    const resolvedTz = defaultTz || (cleanPhone ? detectTimezoneFromPhone(cleanPhone) : 'America/Bogota');
    const resolvedLocale = (defaultLocale === 'es-CO' && cleanPhone)
      ? detectLocaleFromPhone(cleanPhone)
      : (defaultLocale || 'es-CO');

    if (!cleanPhone) {
      return {
        id: null,
        phone_number: '',
        display_name: displayName,
        timezone: resolvedTz,
        locale: resolvedLocale,
        created_at: new Date().toISOString(),
      };
    }

    const cached = userCache.get(cleanPhone);
    if (!fresh && cached?.user?.id && Date.now() - cached.timestamp < USER_CACHE_TTL_MS) {
      if (displayName && !cached.user.display_name) {
        cached.user.display_name = displayName;
        Promise.resolve(getClient().from('users').update({ display_name: displayName }).eq('id', cached.user.id)).then(() => {}).catch(() => {});
      }
      return cached.user;
    }

    try {
      const { data: existingUser, error: selectError } = await getClient()
        .from('users')
        .select('*')
        .eq('phone_number', cleanPhone)
        .maybeSingle();

      if (existingUser && !selectError) {
        if (displayName && !existingUser.display_name) {
          existingUser.display_name = displayName;
          await getClient().from('users').update({ display_name: displayName }).eq('id', existingUser.id);
        }
        userCache.set(cleanPhone, { user: existingUser, timestamp: Date.now() });
        return existingUser;
      }

      const { data: newUser, error: insertError } = await getClient()
        .from('users')
        .insert({
          phone_number: cleanPhone,
          display_name: displayName,
          timezone: resolvedTz,
          locale: resolvedLocale,
        })
        .select()
        .single();

      if (newUser && !insertError) {
        newUser.is_new = true;
        userCache.set(cleanPhone, { user: newUser, timestamp: Date.now() });
        return newUser;
      }

      // In case insert failed due to concurrent creation race, retry select once
      if (insertError) {
        const { data: retryUser } = await getClient()
          .from('users')
          .select('*')
          .eq('phone_number', cleanPhone)
          .maybeSingle();

        if (retryUser) {
          userCache.set(cleanPhone, { user: retryUser, timestamp: Date.now() });
          return retryUser;
        }
      }
    } catch (err) {
      console.error('getOrCreateUserByPhone threw:', err);
    }

    // Transient failure or unpersisted fallback: NEVER store id:null in userCache!
    return {
      id: null,
      phone_number: cleanPhone,
      display_name: displayName,
      timezone: resolvedTz,
      locale: resolvedLocale,
      created_at: new Date().toISOString(),
    };
  }

  async function updateUserPreferences(userId: string, { timezone, locale }: UserPreferences) {
    if (!userId) return null;
    const updates: { updated_at: string; timezone?: string; locale?: string } = { updated_at: new Date().toISOString() };
    if (timezone) updates.timezone = timezone;
    if (locale) updates.locale = locale;

    const { data, error } = await getClient()
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

  async function updateUserTimezone(userId: string, timezone: string) {
    if (!userId || !timezone) return null;
    return updateUserPreferences(userId, { timezone });
  }

  async function updateUserLocale(userId: string, locale: string) {
    if (!userId || !locale) return null;
    return updateUserPreferences(userId, { locale });
  }

  /**
   * Update the user's last inbound message timestamp to maintain 24-hour window status.
   * Updates both Postgres and in-memory userCache.
   *
   * @param {string} userId
   * @param {string} phoneNumber
   * @returns {Promise<void>}
   */
  async function touchUserLastActive(userId: string | null, phoneNumber: string) {
    const nowIso = new Date().toISOString();
    const cleanPhone = normalizeUserPhone(phoneNumber);

    // Update in-memory cache immediately for 0ms lookup
    if (cleanPhone) {
      const cached = userCache.get(cleanPhone);
      if (cached?.user) {
        cached.user.last_user_message_at = nowIso;
        cached.timestamp = Date.now();
      } else {
        userCache.set(cleanPhone, {
          user: { id: userId || null, phone_number: cleanPhone, last_user_message_at: nowIso },
          timestamp: Date.now(),
        });
      }
    }

    const handleDbErr = (err: unknown) => {
      const error = objectError(err);
      if (error.code !== '42703' && !error.message?.includes('last_user_message_at')) {
        console.warn('[users] touchUserLastActive failed:', domainErrorMessage(err));
      }
    };

    // Update Postgres asynchronously (non-blocking)
    if (userId) {
      Promise.resolve(getClient()
        .from('users')
        .update({ last_user_message_at: nowIso, updated_at: nowIso })
        .eq('id', userId))
        .then(() => {})
        .catch(handleDbErr);
    } else if (cleanPhone) {
      Promise.resolve(getClient()
        .from('users')
        .update({ last_user_message_at: nowIso, updated_at: nowIso })
        .eq('phone_number', cleanPhone))
        .then(() => {})
        .catch(handleDbErr);
    }
  }
  return { userCache, normalizeUserPhone, getOrCreateUserByPhone, updateUserPreferences, updateUserTimezone, updateUserLocale, touchUserLastActive };
}
