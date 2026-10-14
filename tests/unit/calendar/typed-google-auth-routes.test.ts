import { describe, expect, it, vi } from 'vitest';
import { createGoogleAuthRouter } from '../../../src/http/routes/google-auth-handlers.js';
import type { GoogleAuthDependencies, HttpHandler, HttpResponse } from '../../../src/http/routes/google-auth-ports.js';
function fixture() {
  const routes = new Map<string, HttpHandler>(); const deps = { createRouter: () => ({ get: (path: string, handler: HttpHandler) => routes.set(path, handler) }), generateGoogleAuthUrl: vi.fn(() => 'https://google.test/auth'), exchangeGoogleCode: vi.fn<GoogleAuthDependencies['exchangeGoogleCode']>(async () => ({ tokens: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expiry_date: 1000, scope: 'calendar email' }, email: 'user@example.test', name: 'User' })), setupGoogleCalendarWatch: vi.fn(async () => {}), saveUserIntegration: vi.fn<GoogleAuthDependencies['saveUserIntegration']>(async () => {}), saveMessage: vi.fn<GoogleAuthDependencies['saveMessage']>(async () => {}), sendReminderConfirmation: vi.fn<GoogleAuthDependencies['sendReminderConfirmation']>(async () => ({ success: true })), getOrCreateUserByPhone: vi.fn(async () => ({ id: 'owner' })), renderGoogleSuccessPage: vi.fn<GoogleAuthDependencies['renderGoogleSuccessPage']>(() => 'Success'), getWhatsAppReturnUrl: () => 'https://wa.me/12084416502', logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } } satisfies GoogleAuthDependencies;
  createGoogleAuthRouter(deps); return { deps, routes };
}
function response() { const res = { status: vi.fn((_code: number): HttpResponse => res), send: vi.fn(), redirect: vi.fn(), set: vi.fn(() => res), json: vi.fn() }; return res; }
const state = Buffer.from(JSON.stringify({ userId: 'owner', phoneNumber: '573000000001' })).toString('base64url');
describe('typed Google OAuth routes', () => {
  it('resolves a phone-only user before redirecting and rejects absent identity', async () => {
    const f = fixture(); const res = response(); await f.routes.get('/')!({ query: { phone: '573000000001' }, headers: {} }, res); expect(f.deps.getOrCreateUserByPhone).toHaveBeenCalledWith('573000000001'); expect(res.redirect).toHaveBeenCalledWith('https://google.test/auth'); const missing = response(); await f.routes.get('/')!({ query: {}, headers: {} }, missing); expect(missing.status).toHaveBeenCalledWith(400);
  });
  it('handles cancellation, missing code and invalid state without exchanging credentials', async () => {
    const f = fixture(); for (const query of [{ error: 'access_denied' }, {}, { code: 'code', state: 'malformed' }]) { const res = response(); await f.routes.get('/callback')!({ query, headers: {} }, res); expect(res.status).toHaveBeenCalledWith('error' in query ? 200 : 400); } expect(f.deps.exchangeGoogleCode).not.toHaveBeenCalled();
  });
  it('persists the exchanged credentials before watch/notification and renders the selected theme', async () => {
    const f = fixture(); const res = response(); await f.routes.get('/callback')!({ query: { code: 'code', state, theme: 'legacy' }, headers: {} }, res); expect(f.deps.saveUserIntegration).toHaveBeenCalledWith('owner', expect.objectContaining({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', tokenExpiry: new Date(1000), scopes: ['calendar', 'email'], accountEmail: 'user@example.test' })); expect(f.deps.saveUserIntegration).toHaveBeenCalledBefore(f.deps.setupGoogleCalendarWatch); expect(f.deps.sendReminderConfirmation).toHaveBeenCalledWith('573000000001', expect.stringContaining('Google Calendar conectado')); expect(f.deps.renderGoogleSuccessPage).toHaveBeenCalledWith({ email: 'user@example.test', theme: 'legacy' }); expect(res.status).toHaveBeenCalledWith(200);
  });
  it('keeps watch and notification failures nonfatal, without transport retry', async () => {
    const f = fixture(); f.deps.setupGoogleCalendarWatch.mockRejectedValue(Error('watch')); f.deps.sendReminderConfirmation.mockRejectedValue(Error('unknown')); f.deps.saveMessage.mockRejectedValue(Error('history')); const res = response(); await f.routes.get('/callback')!({ query: { code: 'code', state }, headers: {} }, res); expect(res.status).toHaveBeenCalledWith(200); expect(f.deps.sendReminderConfirmation).toHaveBeenCalledOnce();
  });
  it('does not render success or start a watch when token persistence fails', async () => {
    const f = fixture(); f.deps.saveUserIntegration.mockRejectedValue(Error('storage')); const res = response(); await f.routes.get('/callback')!({ query: { code: 'code', state }, headers: {} }, res); expect(res.status).toHaveBeenCalledWith(500); expect(f.deps.setupGoogleCalendarWatch).not.toHaveBeenCalled(); expect(f.deps.renderGoogleSuccessPage).not.toHaveBeenCalled();
  });
});
