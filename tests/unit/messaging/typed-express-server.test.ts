import { describe, expect, it, vi } from 'vitest';
import { startExpressServer } from '../../../src/app/server-runtime.js';
import type { ServerDependencies } from '../../../src/app/server-ports.js';
import type { HttpHandler, HttpResponse, HttpRequest } from '../../../src/http/routes/google-auth-ports.js';
function fixture(env: NodeJS.ProcessEnv = { SUPABASE_URL: 'synthetic', SUPABASE_SECRET: 'synthetic', KAPSO_API_KEY: 'synthetic', OPENROUTER_API_KEY: 'synthetic' }) {
  const routes = new Map<string, HttpHandler>(); const signals = new Map<string, () => Promise<void>>(); const close = vi.fn(); const stop = vi.fn(async () => {}); const timer = { unref: vi.fn() };
  const deps = { createApp: () => ({ use: vi.fn(), get: (path: string | string[], handler: HttpHandler) => { for (const key of Array.isArray(path) ? path : [path]) routes.set(key, handler); }, post: vi.fn(), listen: vi.fn((_port: string | number, callback: () => void) => { callback(); return { close }; }) }), staticMiddleware: vi.fn(() => 'static'), jsonMiddleware: vi.fn<ServerDependencies['jsonMiddleware']>(() => 'json'), googleAuthRouter: { get() {} }, handleWebhook: () => {}, handleStripeWebhook: () => {}, handleGoogleCalendarWebhook: () => {}, processWebhookMessage: async () => {}, assertInboundQueueReady: vi.fn(async () => {}), startInboundTurnWorker: vi.fn(() => ({ stop })), buildStripeCheckoutUrl: vi.fn(() => 'https://stripe.test/checkout'), renderSubscriptionSuccessPage: () => 'Subscription', renderPrivacyPolicyPage: () => 'Privacy', renderTermsOfServicePage: () => 'Terms', renderHomePage: () => 'Home', startScheduler: vi.fn(async () => {}), startMorningBriefingWorker: vi.fn(), startCalendarWatchWorker: vi.fn(), getEnv: () => env, once: (signal: string, callback: () => Promise<void>) => signals.set(signal, callback), exit: vi.fn(), setTimeout: vi.fn((_callback: () => unknown, _ms: number) => timer), clearTimeout: vi.fn(), logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } } satisfies ServerDependencies;
  return { deps, routes, signals, close, stop, timer };
}
function response() { const res = { status: vi.fn((_code: number): HttpResponse => res), send: vi.fn(), redirect: vi.fn(), set: vi.fn(() => res), json: vi.fn() }; return res; }
const request = (query: Record<string, unknown> = {}): HttpRequest => ({ query, headers: {} });
describe('typed Express server lifecycle', () => {
  it('fails before listening or workers when critical configuration or queue readiness is missing', async () => {
    const f = fixture({}); await expect(startExpressServer(f.deps)).rejects.toThrow('SUPABASE_URL, SUPABASE_SECRET, KAPSO_API_KEY, OPENROUTER_API_KEY'); expect(f.deps.startInboundTurnWorker).not.toHaveBeenCalled();
    const failed = fixture(); failed.deps.assertInboundQueueReady.mockRejectedValue(Error('queue unavailable')); await expect(startExpressServer(failed.deps)).rejects.toThrow('queue unavailable'); expect(failed.deps.startInboundTurnWorker).not.toHaveBeenCalled(); expect(failed.routes.has('/health')).toBe(false);
  });
  it('waits for readiness and snapshots the port before readiness resolves', async () => {
    const env = { SUPABASE_URL: 's', SUPABASE_SECRET: 's', KAPSO_API_KEY: 's', OPENROUTER_API_KEY: 's', PORT: '3010' }; const f = fixture(env); let release!: () => void; f.deps.assertInboundQueueReady.mockImplementation(() => new Promise(resolve => { release = resolve; })); const work = startExpressServer(f.deps); expect(f.deps.startInboundTurnWorker).not.toHaveBeenCalled(); env.PORT = '3020'; release(); const runtime = await work; expect(runtime.app.listen).toHaveBeenCalledWith('3010', expect.any(Function)); expect(f.deps.startInboundTurnWorker).toHaveBeenCalledExactlyOnceWith(f.deps.processWebhookMessage);
  });
  it.each(['production', 'railway', 'local'])('preserves background host policy: %s', async mode => {
    const f = fixture(); const env = f.deps.getEnv(); if (mode === 'production') env.NODE_ENV = 'production'; if (mode === 'railway') env.RAILWAY_ENVIRONMENT_ID = 'synthetic'; await startExpressServer(f.deps); expect(f.deps.startScheduler).toHaveBeenCalledTimes(mode === 'local' ? 0 : 1); expect(f.deps.startMorningBriefingWorker).toHaveBeenCalledTimes(mode === 'local' ? 0 : 1); expect(f.deps.startCalendarWatchWorker).toHaveBeenCalledTimes(mode === 'local' ? 0 : 1);
  });
  it('retains raw bytes, 2mb JSON limit, no-store pages and live webhook verification', async () => {
    const f = fixture(); await startExpressServer(f.deps); const options = f.deps.jsonMiddleware.mock.calls[0]![0]; expect(options.limit).toBe('2mb'); const req = request(); const bytes = Buffer.from('  {"signed":true}\n'); options.verify(req, null, bytes); expect(req.rawBody).toBe(bytes);
    const home = response(); f.routes.get('/')!(request(), home); expect(home.set).toHaveBeenCalledWith('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    f.deps.getEnv().KAPSO_WEBHOOK_VERIFY_TOKEN = 'secret'; const verified = response(); f.routes.get('/webhook')!(request({ 'hub.mode': 'subscribe', 'hub.verify_token': 'secret', 'hub.challenge': 'challenge' }), verified); expect(verified.send).toHaveBeenCalledWith('challenge'); const rejected = response(); f.routes.get('/webhook')!(request({ 'hub.mode': 'subscribe', 'hub.verify_token': 'bad' }), rejected); expect(rejected.status).toHaveBeenCalledWith(403);
  });
  it('retains Stripe short-link reference precedence and language selection', async () => {
    const f = fixture(); await startExpressServer(f.deps); const res = response(); f.routes.get('/pro')!({ query: { ref: 'preferred', phone: 'phone' }, headers: { 'accept-language': 'en-US' } }, res); expect(f.deps.buildStripeCheckoutUrl).toHaveBeenCalledExactlyOnceWith({ userId: 'preferred', language: 'en' }); expect(res.redirect).toHaveBeenCalledWith(302, 'https://stripe.test/checkout');
  });
  it('closes admission, drains inbound work and exits once with the existing shutdown deadline', async () => {
    const f = fixture(); let release!: () => void; f.stop.mockImplementation(() => new Promise(resolve => { release = resolve; })); const runtime = await startExpressServer(f.deps); const stopping = runtime.shutdown(); expect(f.close).toHaveBeenCalledOnce(); expect(f.deps.setTimeout).toHaveBeenCalledWith(expect.any(Function), 25000); expect(f.timer.unref).toHaveBeenCalledOnce(); expect(f.deps.exit).not.toHaveBeenCalled(); await runtime.shutdown(); release(); await stopping; expect(f.stop).toHaveBeenCalledOnce(); expect(f.deps.clearTimeout).toHaveBeenCalledWith(f.timer); expect(f.deps.exit).toHaveBeenCalledExactlyOnceWith(0); expect([...f.signals.keys()]).toEqual(['SIGTERM', 'SIGINT']);
  });
});
