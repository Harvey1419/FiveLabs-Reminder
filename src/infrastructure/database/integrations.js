import { supabase } from './index.js';

/**
 * Get active integration for a user by provider.
 *
 * @param {string} userId
 * @param {string} [provider='google']
 * @returns {Promise<object|null>}
 */
export async function getUserIntegration(userId, provider = 'google') {
  if (!userId) return null;

  try {
    const { data, error } = await supabase
      .from('user_integrations')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', provider)
      .maybeSingle();

    if (error) {
      console.warn(`[integrations] getUserIntegration warning (${provider}):`, error.message);
      return null;
    }

    return data || null;
  } catch (err) {
    console.error(`[integrations] getUserIntegration error (${provider}):`, err.message);
    return null;
  }
}

/**
 * Save or upsert a user integration.
 *
 * @param {string} userId
 * @param {object} params
 * @param {string} [params.provider='google']
 * @param {string} params.accessToken
 * @param {string} params.refreshToken
 * @param {string|Date|null} [params.tokenExpiry]
 * @param {Array<string>} [params.scopes=[]]
 * @param {string|null} [params.accountEmail]
 * @param {object} [params.metadata={}]
 * @returns {Promise<object>}
 */
export async function saveUserIntegration(userId, {
  provider = 'google',
  accessToken,
  refreshToken,
  tokenExpiry = null,
  scopes = [],
  accountEmail = null,
  metadata = {},
}) {
  if (!userId) throw new Error('userId is required');
  if (!accessToken) throw new Error('accessToken is required');

  const expiryIso = tokenExpiry instanceof Date
    ? tokenExpiry.toISOString()
    : (tokenExpiry ? new Date(tokenExpiry).toISOString() : null);

  const payload = {
    user_id: userId,
    provider,
    access_token: accessToken,
    token_expiry: expiryIso,
    scopes,
    account_email: accountEmail,
    metadata,
    updated_at: new Date().toISOString(),
  };

  // Only update refresh_token if a new one was supplied by Google (Google doesn't always send refresh_token on re-auth)
  if (refreshToken) {
    payload.refresh_token = refreshToken;
  }

  const { data, error } = await supabase
    .from('user_integrations')
    .upsert(payload, { onConflict: 'user_id,provider' })
    .select()
    .single();

  if (error) {
    console.error(`[integrations] saveUserIntegration error (${provider}):`, error.message);
    throw error;
  }

  console.log(`[integrations] Saved ${provider} integration for user ${userId} (${accountEmail || 'no-email'})`);
  return data;
}

/**
 * Delete / disconnect a user integration.
 *
 * @param {string} userId
 * @param {string} [provider='google']
 * @returns {Promise<boolean>}
 */
export async function deleteUserIntegration(userId, provider = 'google') {
  if (!userId) return false;

  try {
    const { error } = await supabase
      .from('user_integrations')
      .delete()
      .eq('user_id', userId)
      .eq('provider', provider);

    if (error) {
      console.warn(`[integrations] deleteUserIntegration error (${provider}):`, error.message);
      return false;
    }

    console.log(`[integrations] Deleted ${provider} integration for user ${userId}`);
    return true;
  } catch (err) {
    console.error(`[integrations] deleteUserIntegration error (${provider}):`, err.message);
    return false;
  }
}

/**
 * Update metadata for an existing user integration.
 *
 * @param {string} userId
 * @param {string} [provider='google']
 * @param {object} metadataUpdates
 * @returns {Promise<object|null>}
 */
export async function updateUserIntegrationMetadata(userId, provider = 'google', metadataUpdates = {}) {
  if (!userId) return null;

  try {
    const existing = await getUserIntegration(userId, provider);
    if (!existing) return null;

    const mergedMetadata = {
      ...(existing.metadata || {}),
      ...metadataUpdates,
    };

    const { data, error } = await supabase
      .from('user_integrations')
      .update({
        metadata: mergedMetadata,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('provider', provider)
      .select()
      .maybeSingle();

    if (error) {
      console.warn(`[integrations] updateUserIntegrationMetadata warning (${provider}):`, error.message);
      return null;
    }

    return data;
  } catch (err) {
    console.error(`[integrations] updateUserIntegrationMetadata error (${provider}):`, err.message);
    return null;
  }
}

/**
 * Get all active user integrations for a provider.
 *
 * @param {string} [provider='google']
 * @returns {Promise<Array<object>>}
 */
export async function getAllActiveIntegrations(provider = 'google') {
  try {
    const { data, error } = await supabase
      .from('user_integrations')
      .select('*')
      .eq('provider', provider)
      .not('refresh_token', 'is', null);

    if (error) {
      console.warn(`[integrations] getAllActiveIntegrations warning (${provider}):`, error.message);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error(`[integrations] getAllActiveIntegrations error (${provider}):`, err.message);
    return [];
  }
}

/**
 * Find user integration matching a Google webhook channelId.
 *
 * @param {string} channelId
 * @param {string} [provider='google']
 * @returns {Promise<object|null>}
 */
export async function getUserIntegrationByChannelId(channelId, provider = 'google') {
  if (!channelId) return null;

  try {
    const { data, error } = await supabase
      .from('user_integrations')
      .select('*')
      .eq('provider', provider);

    if (error) {
      console.warn('[integrations] getUserIntegrationByChannelId warning:', error.message);
      return null;
    }

    const matched = (data || []).find((row) => row.metadata?.channelId === channelId);
    return matched || null;
  } catch (err) {
    console.error('[integrations] getUserIntegrationByChannelId error:', err.message);
    return null;
  }
}
