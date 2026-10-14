import { describe, expect, it, vi } from 'vitest';
import { createGoogleAuth, type GoogleAuthClient, type GoogleAuthTokens, type GoogleAuthDependencies, type GoogleAuthEnvironment } from '../../../src/integrations/google/google-auth.js';
const NOW = Date.parse('2026-10-13T12:00:00Z');
function fixture() {
  const tokens: GoogleAuthTokens = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expiry_date: NOW + 3600000, id_token: 'synthetic-id', scope: 'saved-scope' };
  const listeners: ((tokens: GoogleAuthTokens) => Promise<void>)[] = [];
  const client: GoogleAuthClient = { generateAuthUrl: vi.fn(() => 'https://accounts.example.test/auth'), getToken: vi.fn(async () => ({ tokens })), setCredentials: vi.fn(), on: vi.fn((_event, listener) => { listeners.push(listener); }), revokeToken: vi.fn(async () => ({})) };
  const env: GoogleAuthEnvironment = { APP_BASE_URL: 'https://hermes.example.test/', GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' };
  const integration = { access_token: 'old-access', refresh_token: 'old-refresh', token_expiry: new Date(NOW + 3600000).toISOString(), scopes: ['saved-scope'], account_email: 'owner@example.test', metadata: { channel: 'synthetic' } };
  const deps: GoogleAuthDependencies<GoogleAuthClient> = { getEnvironment: () => env, now: () => NOW, createOAuthClient: vi.fn(() => client), getUserInfo: vi.fn(async () => ({ data: { email: 'owner@example.test', name: 'Owner' } })), getUserIntegration: vi.fn(async () => integration), saveUserIntegration: vi.fn(async () => ({})), deleteUserIntegration: vi.fn(async () => true), logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  return { deps, client, env, integration, tokens, listeners, ...createGoogleAuth(deps) };
}
describe('typed Google credentials and OAuth policy', () => {
  it('retains live redirects and warns once per instance for invalid callback configuration', () => {
    const f = fixture(); f.env.GOOGLE_REDIRECT_URI = 'https://callback.example.test/auth/google/callback?bad=1';
    expect(f.getGoogleRedirectUri()).toBe('https://hermes.example.test/auth/google/callback'); f.getGoogleRedirectUri(); expect(f.deps.logger.warn).toHaveBeenCalledTimes(1);
    f.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/auth/google/callback/'; expect(f.getGoogleRedirectUri()).toBe('http://localhost:3000/auth/google/callback');
    f.env.APP_BASE_URL = 'https://another.example.test'; f.env.GOOGLE_REDIRECT_URI = ''; expect(f.getGoogleRedirectUri()).toBe('https://another.example.test/auth/google/callback');
  });
  it('treats an access-only token at the sixty-second boundary as unusable but retains refresh recovery', () => {
    const f = fixture(); expect(f.hasUsableGoogleCredentials({ access_token: 'access', token_expiry: NOW + 60000 })).toBe(false);
    expect(f.hasUsableGoogleCredentials({ access_token: 'access', token_expiry: NOW + 60001 })).toBe(true);
    expect(f.hasUsableGoogleCredentials({ refresh_token: 'refresh', token_expiry: NOW - 1 })).toBe(true);
    expect(f.hasUsableGoogleCredentials({ access_token: 'access', token_expiry: 'invalid' })).toBe(true);
    expect(f.hasUsableGoogleCredentials({})).toBe(false); expect(f.hasUsableGoogleCredentials(null)).toBe(false);
  });
  it('distinguishes authentication failures from generic 403 quota/resource errors and tolerates cyclic payloads', () => {
    const f = fixture(); expect(f.isGoogleAuthError({ response: { status: 403, data: { error: 'quota exceeded' } } })).toBe(false);
    expect(f.isGoogleAuthError({ response: { status: 403, data: { error: 'invalid_grant' } } })).toBe(true);
    expect(f.isGoogleAuthError({ code: 401 })).toBe(true); expect(f.isGoogleAuthError({ code: 'GOOGLE_AUTH_REQUIRED' })).toBe(true);
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic; expect(f.isGoogleAuthError({ response: { data: cyclic } })).toBe(false);
  });
  it('requires configured credentials before constructing the SDK client and preserves explicit redirects', () => {
    const f = fixture(); f.env.GOOGLE_CLIENT_SECRET = ''; expect(() => f.createOAuth2Client()).toThrow('Google OAuth credentials not configured'); expect(f.deps.createOAuthClient).not.toHaveBeenCalled();
    f.env.GOOGLE_CLIENT_SECRET = 'synthetic-secret'; expect(f.createOAuth2Client('https://explicit.example.test/callback')).toBe(f.client);
    expect(f.deps.createOAuthClient).toHaveBeenCalledWith('synthetic-client', 'synthetic-secret', 'https://explicit.example.test/callback');
  });
  it('generates existing consent scopes and exact state without a token exchange or persistence', () => {
    const f = fixture(); expect(f.generateGoogleAuthUrl({ userId: 'owner', phoneNumber: '15550001111' })).toBe('https://accounts.example.test/auth');
    const options = vi.mocked(f.client.generateAuthUrl).mock.calls[0]![0];
    expect(JSON.parse(Buffer.from(options.state, 'base64url').toString())).toEqual({ userId: 'owner', phoneNumber: '15550001111', ts: NOW });
    expect(options).toMatchObject({ access_type: 'offline', prompt: 'consent' }); expect(options.scope).toHaveLength(4);
    expect(f.client.getToken).not.toHaveBeenCalled(); expect(f.deps.saveUserIntegration).not.toHaveBeenCalled();
    expect(() => f.generateGoogleAuthUrl({ userId: null })).toThrow('userId is required');
  });
  it('preserves branded phone precedence and missing-user query coercion', () => {
    const f = fixture(); expect(f.getGoogleConnectUrl({ userId: 'owner', phoneNumber: '+1 555' })).toBe('https://hermes.example.test/auth/google?phone=%2B1%20555');
    expect(f.getGoogleConnectUrl({ userId: undefined })).toBe('https://hermes.example.test/auth/google?userId=undefined');
  });
});
describe('typed Google auth SDK and persistence orchestration', () => {
  it('returns original exchanged tokens and attaches credentials before reading the profile', async () => {
    const f = fixture(); const result = await f.exchangeGoogleCode('synthetic-code'); expect(result.tokens).toBe(f.tokens); expect(result.email).toBe('owner@example.test');
    expect(f.client.setCredentials).toHaveBeenCalledWith(f.tokens); expect(f.deps.getUserInfo).toHaveBeenCalledWith(f.client); expect(f.deps.saveUserIntegration).not.toHaveBeenCalled();
    expect(vi.mocked(f.client.setCredentials).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.deps.getUserInfo).mock.invocationCallOrder[0]!);
  });
  it('retains exchanged tokens after optional profile failure and propagates token-exchange errors without retry', async () => {
    const f = fixture(); vi.mocked(f.deps.getUserInfo).mockRejectedValue(new Error('profile unavailable'));
    expect(await f.exchangeGoogleCode('synthetic-code')).toEqual({ tokens: f.tokens, email: null, name: null }); expect(f.deps.logger.warn).toHaveBeenCalledTimes(1);
    vi.mocked(f.client.getToken).mockRejectedValue(new Error('invalid code')); await expect(f.exchangeGoogleCode('synthetic-code')).rejects.toThrow('invalid code'); expect(f.client.getToken).toHaveBeenCalledTimes(2);
  });
  it('cleans only expired access-only integrations before returning no client', async () => {
    const f = fixture(); vi.mocked(f.deps.getUserIntegration).mockResolvedValue({ access_token: 'access', token_expiry: NOW + 60000 });
    expect(await f.getAuthenticatedGoogleClient('owner')).toBeNull(); expect(f.deps.deleteUserIntegration).toHaveBeenCalledWith('owner', 'google'); expect(f.deps.createOAuthClient).not.toHaveBeenCalled();
    vi.mocked(f.deps.getUserIntegration).mockResolvedValue({}); await f.getAuthenticatedGoogleClient('owner'); expect(f.deps.deleteUserIntegration).toHaveBeenCalledTimes(1);
  });
  it('hydrates refresh-only credentials and preserves explicit undefined expiry without an eager save', async () => {
    const f = fixture(); vi.mocked(f.deps.getUserIntegration).mockResolvedValue({ refresh_token: 'refresh' });
    expect(await f.getAuthenticatedGoogleClient('owner')).toBe(f.client); expect(f.client.setCredentials).toHaveBeenCalledWith({ access_token: undefined, refresh_token: 'refresh', expiry_date: undefined });
    expect(f.listeners).toHaveLength(1); expect(f.deps.saveUserIntegration).not.toHaveBeenCalled();
  });
  it('saves emitted refresh tokens with observed fallbacks, original scopes/account metadata and converted expiry', async () => {
    const f = fixture(); await f.getAuthenticatedGoogleClient('owner'); await f.listeners[0]!({ access_token: 'fresh-access', expiry_date: NOW + 7200000 });
    expect(f.deps.saveUserIntegration).toHaveBeenCalledWith('owner', { provider: 'google', accessToken: 'fresh-access', refreshToken: 'old-refresh', tokenExpiry: new Date(NOW + 7200000), scopes: f.integration.scopes, accountEmail: f.integration.account_email, metadata: f.integration.metadata });
    expect(f.deps.saveUserIntegration).toHaveBeenCalledTimes(1);
  });
  it('logs refresh persistence errors without replaying or rejecting the token listener', async () => {
    const f = fixture(); vi.mocked(f.deps.saveUserIntegration).mockRejectedValue(new Error('save failed')); await f.getAuthenticatedGoogleClient('owner');
    await expect(f.listeners[0]!({})).resolves.toBeUndefined(); expect(f.deps.saveUserIntegration).toHaveBeenCalledTimes(1); expect(f.deps.logger.error).toHaveBeenCalledTimes(1);
  });
  it('prefers refresh token revocation and deletes locally even if remote revocation fails', async () => {
    const f = fixture(); vi.mocked(f.client.revokeToken).mockRejectedValue(new Error('remote failed'));
    expect(await f.revokeGoogleIntegration('owner')).toBe(true); expect(f.client.revokeToken).toHaveBeenCalledWith('old-refresh'); expect(f.deps.deleteUserIntegration).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.client.revokeToken).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.deps.deleteUserIntegration).mock.invocationCallOrder[0]!);
  });
  it('preserves cleanup false, revoke deletion errors and empty-user/absent-integration results', async () => {
    const f = fixture(); vi.mocked(f.deps.deleteUserIntegration).mockRejectedValue(new Error('delete failed')); expect(await f.clearInvalidGoogleIntegration('owner')).toBe(false);
    await expect(f.revokeGoogleIntegration('owner')).rejects.toThrow('delete failed');
    expect(await f.getAuthenticatedGoogleClient(null)).toBeNull(); expect(await f.revokeGoogleIntegration(null)).toBe(false);
    vi.mocked(f.deps.getUserIntegration).mockResolvedValue(null); expect(await f.revokeGoogleIntegration('owner')).toBe(true);
  });
});
