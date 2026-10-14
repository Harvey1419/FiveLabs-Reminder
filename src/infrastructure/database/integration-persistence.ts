import type { JsonObject } from '@templelabs/contracts';
import { domainErrorMessage,type IntegrationPersistenceClient } from './profile-integration-client.js';
export interface SaveIntegrationInput { provider?: string; accessToken: string; refreshToken?: string | null;
  tokenExpiry?: string | Date | null; scopes?: string[]; accountEmail?: string | null; metadata?: JsonObject }
/** User/provider identity scopes reads, updates, disconnects and token-preserving upserts. */
export function createIntegrationPersistence(getClient: () => IntegrationPersistenceClient) {
  /**
   * Get active integration for a user by provider.
   *
   * @param {string} userId
   * @param {string} [provider='google']
   * @returns {Promise<object|null>}
   */
  async function getUserIntegration(userId: string, provider = 'google') {
    if (!userId) return null;

    try {
      const { data, error } = await getClient()
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
      console.error(`[integrations] getUserIntegration error (${provider}):`, domainErrorMessage(err));
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
  async function saveUserIntegration(userId: string, {
    provider = 'google',
    accessToken,
    refreshToken,
    tokenExpiry = null,
    scopes = [],
    accountEmail = null,
    metadata = {},
  }: SaveIntegrationInput) {
    if (!userId) throw new Error('userId is required');
    if (!accessToken) throw new Error('accessToken is required');

    const expiryIso = tokenExpiry instanceof Date
      ? tokenExpiry.toISOString()
      : (tokenExpiry ? new Date(tokenExpiry).toISOString() : null);

    const payload: JsonObject = {
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

    const { data, error } = await getClient()
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
  async function deleteUserIntegration(userId: string, provider = 'google') {
    if (!userId) return false;

    try {
      const { error } = await getClient()
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
      console.error(`[integrations] deleteUserIntegration error (${provider}):`, domainErrorMessage(err));
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
  async function updateUserIntegrationMetadata(userId: string, provider = 'google', metadataUpdates: JsonObject = {}) {
    if (!userId) return null;

    try {
      const existing = await getUserIntegration(userId, provider);
      if (!existing) return null;

      const mergedMetadata = {
        ...(existing.metadata || {}),
        ...metadataUpdates,
      };

      const { data, error } = await getClient()
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
      console.error(`[integrations] updateUserIntegrationMetadata error (${provider}):`, domainErrorMessage(err));
      return null;
    }
  }

  /**
   * Get all active user integrations for a provider.
   *
   * @param {string} [provider='google']
   * @returns {Promise<Array<object>>}
   */
  async function getAllActiveIntegrations(provider = 'google') {
    try {
      const { data, error } = await getClient()
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
      console.error(`[integrations] getAllActiveIntegrations error (${provider}):`, domainErrorMessage(err));
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
  async function getUserIntegrationByChannelId(channelId: string, provider = 'google') {
    if (!channelId) return null;

    try {
      const { data, error } = await getClient()
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
      console.error('[integrations] getUserIntegrationByChannelId error:', domainErrorMessage(err));
      return null;
    }
  }
  return { getUserIntegration, saveUserIntegration, deleteUserIntegration, updateUserIntegrationMetadata, getAllActiveIntegrations, getUserIntegrationByChannelId };
}
