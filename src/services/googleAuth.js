import { google } from 'googleapis';
import { getUserIntegration, saveUserIntegration, deleteUserIntegration } from '../db/index.js';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

/**
 * Get configured OAuth2 client instance.
 *
 * @param {string|null} [redirectUri]
 * @returns {google.auth.OAuth2}
 */
export function createOAuth2Client(redirectUri = null) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const defaultRedirect = process.env.GOOGLE_REDIRECT_URI ||
    (process.env.APP_BASE_URL
      ? `${process.env.APP_BASE_URL.replace(/\/$/, '')}/auth/google/callback`
      : 'https://hermes.templelabs.co/auth/google/callback');

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth credentials not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)');
  }

  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri || defaultRedirect
  );
}

/**
 * Generate 1-click Google OAuth URL for a specific user.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.phoneNumber]
 * @param {string} [params.redirectUri]
 * @returns {string} Google authorization URL
 */
export function generateGoogleAuthUrl({ userId, phoneNumber = null, redirectUri = null }) {
  if (!userId) throw new Error('userId is required to generate auth url');

  const oauth2Client = createOAuth2Client(redirectUri);

  // Encode state with userId and optional timestamp/phone
  const statePayload = Buffer.from(JSON.stringify({
    userId,
    phoneNumber,
    ts: Date.now(),
  })).toString('base64url');

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Requests refresh_token
    prompt: 'consent',     // Forces consent to ensure refresh_token is returned
    scope: GOOGLE_SCOPES,
    state: statePayload,
  });

  return authUrl;
}

/**
 * Get clean, short branded connection URL that 302-redirects to Google OAuth.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.phoneNumber]
 * @returns {string}
 */
export function getGoogleConnectUrl({ userId, phoneNumber = null }) {
  const baseUrl = process.env.APP_BASE_URL
    ? process.env.APP_BASE_URL.replace(/\/$/, '')
    : 'https://hermes.templelabs.co';

  const query = phoneNumber
    ? `phone=${encodeURIComponent(phoneNumber)}`
    : `userId=${encodeURIComponent(userId)}`;

  return `${baseUrl}/auth/google?${query}`;
}

/**
 * Exchange Google authorization code for tokens and fetch user email profile.
 *
 * @param {string} code
 * @param {string|null} [redirectUri]
 * @returns {Promise<{tokens: object, email: string|null, name: string|null}>}
 */
export async function exchangeGoogleCode(code, redirectUri = null) {
  if (!code) throw new Error('Authorization code is required');

  const oauth2Client = createOAuth2Client(redirectUri);
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  let email = null;
  let name = null;

  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();
    email = userInfo.email || null;
    name = userInfo.name || null;
  } catch (err) {
    console.warn('[googleAuth] could not fetch userinfo:', err.message);
  }

  return { tokens, email, name };
}

/**
 * Get authenticated Google OAuth2 client for a user.
 * Automatically refreshes tokens and saves refreshed access_token to DB.
 *
 * @param {string} userId
 * @returns {Promise<google.auth.OAuth2|null>}
 */
export async function getAuthenticatedGoogleClient(userId) {
  if (!userId) return null;

  const integration = await getUserIntegration(userId, 'google');
  if (!integration || (!integration.access_token && !integration.refresh_token)) {
    return null;
  }

  const oauth2Client = createOAuth2Client();

  oauth2Client.setCredentials({
    access_token: integration.access_token,
    refresh_token: integration.refresh_token,
    expiry_date: integration.token_expiry ? new Date(integration.token_expiry).getTime() : undefined,
  });

  // Listen to automatic token refresh events and persist updated tokens
  oauth2Client.on('tokens', async (newTokens) => {
    try {
      console.log(`[googleAuth] Refreshed Google token for user ${userId}`);
      await saveUserIntegration(userId, {
        provider: 'google',
        accessToken: newTokens.access_token || integration.access_token,
        refreshToken: newTokens.refresh_token || integration.refresh_token,
        tokenExpiry: newTokens.expiry_date ? new Date(newTokens.expiry_date) : null,
        scopes: integration.scopes || GOOGLE_SCOPES,
        accountEmail: integration.account_email,
        metadata: integration.metadata || {},
      });
    } catch (saveErr) {
      console.error('[googleAuth] Failed to persist refreshed token:', saveErr.message);
    }
  });

  return oauth2Client;
}

/**
 * Revoke Google access and delete integration record.
 *
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function revokeGoogleIntegration(userId) {
  if (!userId) return false;

  const integration = await getUserIntegration(userId, 'google');
  if (!integration) return true;

  try {
    if (integration.access_token || integration.refresh_token) {
      const oauth2Client = createOAuth2Client();
      await oauth2Client.revokeToken(integration.refresh_token || integration.access_token);
      console.log(`[googleAuth] Revoked Google token for user ${userId}`);
    }
  } catch (err) {
    console.warn('[googleAuth] revokeToken warning:', err.message);
  }

  return await deleteUserIntegration(userId, 'google');
}
