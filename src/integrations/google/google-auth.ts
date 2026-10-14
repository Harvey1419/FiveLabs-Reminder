export interface GoogleAuthEnvironment { APP_BASE_URL?: string | undefined; GOOGLE_REDIRECT_URI?: string | undefined; GOOGLE_CLIENT_ID?: string | undefined; GOOGLE_CLIENT_SECRET?: string | undefined }
export interface GoogleAuthTokens { access_token?: string | null | undefined; refresh_token?: string | null | undefined; expiry_date?: number | null | undefined; token_type?: string | null | undefined; id_token?: string | null | undefined; scope?: string | undefined }
export interface GoogleAuthClient {
  generateAuthUrl(options: { access_type: 'offline'; prompt: 'consent'; scope: string[]; state: string }): string;
  getToken(code: string): Promise<{ tokens: GoogleAuthTokens }>;
  setCredentials(tokens: GoogleAuthTokens): void;
  on(event: 'tokens', callback: (tokens: GoogleAuthTokens) => Promise<void>): unknown;
  revokeToken(token: string): Promise<unknown>;
}
export interface GoogleAuthIntegration {
  access_token?: string | null | undefined; refresh_token?: string | null | undefined;
  token_expiry?: string | number | Date | null; scopes?: unknown; account_email?: unknown; metadata?: unknown;
}
export interface GoogleRefreshedIntegration {
  provider: 'google'; accessToken: string | null | undefined; refreshToken: string | null | undefined;
  tokenExpiry: Date | null; scopes: unknown; accountEmail: unknown; metadata: unknown;
}
export interface GoogleAuthDependencies<Client extends GoogleAuthClient> {
  getEnvironment(): GoogleAuthEnvironment;
  now(): number;
  createOAuthClient(clientId: string, clientSecret: string, redirectUri: string): Client;
  getUserInfo(client: Client): Promise<{ data: { email?: string | null; name?: string | null } }>;
  getUserIntegration(userId: string, provider: 'google'): Promise<unknown>;
  saveUserIntegration(userId: string, input: GoogleRefreshedIntegration): Promise<unknown>;
  deleteUserIntegration(userId: string, provider: 'google'): Promise<boolean>;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}
interface GoogleErrorView { message?: unknown; code?: unknown; status?: unknown; response?: { status?: unknown; data?: unknown } }

/** SDK and persistence remain host capabilities; each instance owns its one-time redirect warning. */
export function createGoogleAuth<Client extends GoogleAuthClient>({ getEnvironment, now, createOAuthClient, getUserInfo,
  getUserIntegration, saveUserIntegration, deleteUserIntegration, logger: console }: GoogleAuthDependencies<Client>) {
  const GOOGLE_SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ];

  let warnedInvalidRedirectUri = false;

  function getGoogleRedirectUri() {
    const appBaseUrl = (getEnvironment().APP_BASE_URL || 'https://hermes.templelabs.co').replace(/\/$/, '');
    const canonicalRedirect = `${appBaseUrl}/auth/google/callback`;
    const configuredRedirect = String(getEnvironment().GOOGLE_REDIRECT_URI || '').trim();
    if (!configuredRedirect) return canonicalRedirect;

    try {
      const parsed = new URL(configuredRedirect);
      const hasExpectedCallbackPath = parsed.pathname.replace(/\/$/, '').endsWith('/auth/google/callback');
      if (['https:', 'http:'].includes(parsed.protocol) && hasExpectedCallbackPath && !parsed.search && !parsed.hash) {
        return parsed.toString().replace(/\/$/, '');
      }
    } catch {
      // Fall through to the canonical application callback.
    }

    if (!warnedInvalidRedirectUri) {
      console.warn('[googleAuth] GOOGLE_REDIRECT_URI is invalid for the Google callback route; using APP_BASE_URL callback.');
      warnedInvalidRedirectUri = true;
    }
    return canonicalRedirect;
  }

  function isExpiredToken(tokenExpiry: unknown) {
    if (!tokenExpiry) return false;
    const expiry = new Date(tokenExpiry as string | number).getTime();
    if (Number.isNaN(expiry)) return false;
    // An access-token-only integration cannot recover through refresh. Treat a
    // token near expiry as unusable instead of presenting a connection that can
    // no longer complete the next Google request.
    return expiry <= (now() + 60_000);
  }

  function isGoogleAuthError(value: unknown): boolean {
    const error = value as GoogleErrorView | null | undefined;
    const message = String(error?.message || '').toLowerCase();
    const errorCode = String(error?.code || error?.status || error?.response?.status || '');
    const responseData = error?.response?.data;
    let responseText = '';
    try {
      responseText = typeof responseData === 'string'
        ? responseData.toLowerCase()
        : JSON.stringify(responseData || {}).toLowerCase();
    } catch {
      responseText = '';
    }

    if (errorCode === '401' || error?.code === 'GOOGLE_AUTH_REQUIRED') return true;

    const combined = [message, responseText].join(' ');
    const knownAuthFailure = combined.includes('unauthorized_client')
      || combined.includes('invalid_client')
      || combined.includes('invalid_grant')
      || combined.includes('invalid_token')
      || combined.includes('token has expired')
      || combined.includes('invalid credentials')
      || combined.includes('could not refresh access token')
      || combined.includes('credentials have expired')
      || combined.includes('access token has expired')
      || combined.includes('not found: refresh token')
      || combined.includes('autherror')
      || combined.includes('insufficient authentication scopes');

    // A generic 403 can be quota, API policy, or resource permissions. Only
    // clear credentials when its payload specifically identifies auth failure.
    return knownAuthFailure;
  }

  function hasUsableGoogleCredentials(value: unknown): boolean {
    const integration = value as GoogleAuthIntegration | null | undefined;
    if (!integration) return false;

    const hasAnyToken = Boolean(integration.access_token || integration.refresh_token);
    if (!hasAnyToken) return false;

    // If we only have an access token and it is expired, do not consider this
    // a live connection. Refresh token can usually recover a fresh access token.
    if (integration.access_token && !integration.refresh_token && isExpiredToken(integration.token_expiry)) {
      return false;
    }

    return true;
  }

  async function clearInvalidGoogleIntegration(userId: string | null | undefined, context = 'google_auth'): Promise<boolean> {
    if (!userId) return false;

    try {
      const removed = await deleteUserIntegration(userId, 'google');
      if (removed) {
        console.log(`[googleAuth] Removed invalid Google integration for user ${userId} (${context}).`);
      }
      return removed;
    } catch (cleanupErr) {
      console.warn('[googleAuth] failed to clear invalid Google integration:', (cleanupErr as { message?: unknown }).message);
      return false;
    }
  }

  /**
   * Get configured OAuth2 client instance.
   *
   * @param {string|null} [redirectUri]
   * @returns {google.auth.OAuth2}
   */
  function createOAuth2Client(redirectUri: string | null = null): Client {
    const clientId = getEnvironment().GOOGLE_CLIENT_ID;
    const clientSecret = getEnvironment().GOOGLE_CLIENT_SECRET;
    const defaultRedirect = getGoogleRedirectUri();

    if (!clientId || !clientSecret) {
      throw new Error('Google OAuth credentials not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)');
    }

    return createOAuthClient(
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
  function generateGoogleAuthUrl({ userId, phoneNumber = null, redirectUri = null }: { userId: string | null | undefined; phoneNumber?: string | null; redirectUri?: string | null }): string {
    if (!userId) throw new Error('userId is required to generate auth url');

    const oauth2Client = createOAuth2Client(redirectUri);

    // Encode state with userId and optional timestamp/phone
    const statePayload = Buffer.from(JSON.stringify({
      userId,
      phoneNumber,
      ts: now(),
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
  function getGoogleConnectUrl({ userId, phoneNumber = null }: { userId: unknown; phoneNumber?: unknown }): string {
    const baseUrl = getEnvironment().APP_BASE_URL
      ? getEnvironment().APP_BASE_URL!.replace(/\/$/, '')
      : 'https://hermes.templelabs.co';

    const query = phoneNumber
      ? `phone=${encodeURIComponent(phoneNumber as string)}`
      : `userId=${encodeURIComponent(userId as string)}`;

    return `${baseUrl}/auth/google?${query}`;
  }

  /**
   * Exchange Google authorization code for tokens and fetch user email profile.
   *
   * @param {string} code
   * @param {string|null} [redirectUri]
   * @returns {Promise<{tokens: object, email: string|null, name: string|null}>}
   */
  async function exchangeGoogleCode(code: string, redirectUri: string | null = null) {
    if (!code) throw new Error('Authorization code is required');

    const oauth2Client = createOAuth2Client(redirectUri);
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    let email: string | null = null;
    let name: string | null = null;

    try {
      const { data: userInfo } = await getUserInfo(oauth2Client);
      email = userInfo.email || null;
      name = userInfo.name || null;
    } catch (err) {
      console.warn('[googleAuth] could not fetch userinfo:', (err as { message?: unknown }).message);
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
  async function getAuthenticatedGoogleClient(userId: string | null | undefined): Promise<Client | null> {
    if (!userId) return null;

    const integration = await getUserIntegration(userId, 'google') as GoogleAuthIntegration | null | undefined;
    if (!hasUsableGoogleCredentials(integration)) {
      if (integration && integration.access_token && !integration.refresh_token && isExpiredToken(integration.token_expiry)) {
        await clearInvalidGoogleIntegration(userId, 'expired-access-token');
      }
      return null;
    }

    const oauth2Client = createOAuth2Client();

    oauth2Client.setCredentials({
      access_token: integration!.access_token,
      refresh_token: integration!.refresh_token,
      expiry_date: integration!.token_expiry ? new Date(integration!.token_expiry).getTime() : undefined,
    });

    // Listen to automatic token refresh events and persist updated tokens
    oauth2Client.on('tokens', async (newTokens) => {
      try {
        console.log(`[googleAuth] Refreshed Google token for user ${userId}`);
        await saveUserIntegration(userId, {
          provider: 'google',
          accessToken: newTokens.access_token || integration!.access_token,
          refreshToken: newTokens.refresh_token || integration!.refresh_token,
          tokenExpiry: newTokens.expiry_date ? new Date(newTokens.expiry_date) : null,
          scopes: integration!.scopes || GOOGLE_SCOPES,
          accountEmail: integration!.account_email,
          metadata: integration!.metadata || {},
        });
      } catch (saveErr) {
        console.error('[googleAuth] Failed to persist refreshed token:', (saveErr as { message?: unknown }).message);
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
  async function revokeGoogleIntegration(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;

    const integration = await getUserIntegration(userId, 'google') as GoogleAuthIntegration | null | undefined;
    if (!integration) return true;

    try {
      if (integration.access_token || integration.refresh_token) {
        const oauth2Client = createOAuth2Client();
        await oauth2Client.revokeToken((integration.refresh_token || integration.access_token) as string);
        console.log(`[googleAuth] Revoked Google token for user ${userId}`);
      }
    } catch (err) {
      console.warn('[googleAuth] revokeToken warning:', (err as { message?: unknown }).message);
    }

    return await deleteUserIntegration(userId, 'google');
  }

  return { getGoogleRedirectUri, isGoogleAuthError, hasUsableGoogleCredentials, clearInvalidGoogleIntegration,
    createOAuth2Client, generateGoogleAuthUrl, getGoogleConnectUrl, exchangeGoogleCode, getAuthenticatedGoogleClient, revokeGoogleIntegration };
}
