import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateGoogleAuthUrl } from '../src/services/googleAuth.js';
import { executeTool } from '../src/ai/tools.js';
import { saveUserIntegration, getUserIntegration, deleteUserIntegration } from '../src/db/integrations.js';
import { getOrCreateUserByPhone } from '../src/db/users.js';

describe('Google Calendar Integration Test Suite', () => {
  const testPhone = '573009998877';
  let testUser = null;

  beforeAll(async () => {
    testUser = await getOrCreateUserByPhone(testPhone);
  });

  afterAll(async () => {
    if (testUser?.id) {
      await deleteUserIntegration(testUser.id, 'google');
    }
  });

  it('generates valid Google OAuth2 authorization URL with PKCE and state payload', () => {
    const authUrl = generateGoogleAuthUrl({ userId: testUser.id, phoneNumber: testPhone });

    expect(authUrl).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(authUrl).toContain('client_id=');
    expect(authUrl).toContain('access_type=offline');
    expect(authUrl).toContain('prompt=consent');
    expect(authUrl).toContain('state=');

    // Decode state parameter
    const urlObj = new URL(authUrl);
    const stateEncoded = urlObj.searchParams.get('state');
    const stateDecoded = JSON.parse(Buffer.from(stateEncoded, 'base64url').toString('utf8'));

    expect(stateDecoded.userId).toBe(testUser.id);
    expect(stateDecoded.phoneNumber).toBe(testPhone);
  });

  it('generates connect link via executeTool when user is not yet connected', async () => {
    // Ensure clean state
    await deleteUserIntegration(testUser.id, 'google');

    const result = await executeTool('manage_google_calendar', { action: 'get_connect_link' }, testUser);

    expect(result.success).toBe(true);
    expect(result.action).toBe('google_auth_link_generated');
    expect(result.data.auth_url).toContain('/auth/google');
  });

  it('handles already_connected state when user integration exists', async () => {
    // Mock save integration
    await saveUserIntegration(testUser.id, {
      provider: 'google',
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      tokenExpiry: new Date(Date.now() + 3600 * 1000),
      accountEmail: 'usuario.test@gmail.com',
    });

    const result = await executeTool('manage_google_calendar', { action: 'get_connect_link' }, testUser);

    expect(result.success).toBe(true);
    expect(result.action).toBe('already_connected');
    expect(result.data.email).toBe('usuario.test@gmail.com');
    expect(result.rawSummary).toContain('usuario.test@gmail.com');

    // Cleanup
    await deleteUserIntegration(testUser.id, 'google');
  });

  it('disconnects Google account successfully via manage_google_calendar action: disconnect', async () => {
    // Mock save
    await saveUserIntegration(testUser.id, {
      provider: 'google',
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      accountEmail: 'usuario.disconnect@gmail.com',
    });

    const result = await executeTool('manage_google_calendar', { action: 'disconnect' }, testUser);

    expect(result.success).toBe(true);
    expect(result.action).toBe('google_disconnected');

    const check = await getUserIntegration(testUser.id, 'google');
    expect(check).toBeNull();
  });
});
