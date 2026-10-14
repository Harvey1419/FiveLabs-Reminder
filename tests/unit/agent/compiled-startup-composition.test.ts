import { describe, expect, it, vi } from 'vitest';
import { createServerDependencies, startApplication } from '../../../dist/runtime/app/server-composition.js';
import type { ServerDependencies } from '../../../src/app/server-ports.js';
function fixture(production = false) {
 const events: string[] = []; const signals = new Map<string, () => Promise<void>>();
 const stop = vi.fn(async () => { events.push('stop'); }); const exit = vi.fn();
 const app: ReturnType<ServerDependencies['createApp']> = {
  use: () => undefined, get: () => undefined, post: () => undefined,
  listen: () => { events.push('listen'); return { close: () => { events.push('close'); } }; },
 };
 const timer = { unref: vi.fn() };
 const overrides: Partial<ServerDependencies> = {
  createApp: () => app, getEnv: () => ({ SUPABASE_URL: 'https://synthetic.test', SUPABASE_SECRET: 'synthetic', KAPSO_API_KEY: 'synthetic', OPENROUTER_API_KEY: 'synthetic', NODE_ENV: production ? 'production' : 'test' }),
  assertInboundQueueReady: async () => { events.push('ready'); },
  startInboundTurnWorker: () => { events.push('inbound'); return { stop }; },
  startScheduler: async () => { events.push('scheduler'); },
  startMorningBriefingWorker: () => { events.push('briefing'); }, startCalendarWatchWorker: () => { events.push('watch'); },
  once: (signal, callback) => { signals.set(signal, callback); }, exit,
  setTimeout: () => timer, clearTimeout: vi.fn(), logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
 };
 return { overrides, events, signals, stop, exit, timer };
}
describe('compiled application composition', () => {
 it('constructs default bindings without starting a listener or worker', () => {
  const dependencies = createServerDependencies();
  expect(typeof dependencies.assertInboundQueueReady).toBe('function');
  expect(typeof dependencies.processWebhookMessage).toBe('function');
  expect(typeof dependencies.googleAuthRouter).toBe('function');
  expect(dependencies.renderHomePage()).toContain('Hermes');
 });
 it('rejects missing environment before queue checks or listener creation', async () => {
  const f = fixture();
  await expect(startApplication({ ...f.overrides, getEnv: () => ({}) })).rejects.toThrow('Missing required environment variables');
  expect(f.events).toEqual([]);
 });
 it('does not admit HTTP traffic or workers before durable queue readiness', async () => {
  const f = fixture();
  await expect(startApplication({ ...f.overrides, assertInboundQueueReady: async () => { throw new Error('queue unavailable'); } })).rejects.toThrow('queue unavailable');
  expect(f.events).toEqual([]); expect(f.signals.size).toBe(0);
 });
 it('orders compiled production startup and drains inbound work once', async () => {
  const f = fixture(true); const runtime = await startApplication(f.overrides);
  expect(f.events).toEqual(['ready', 'listen', 'inbound', 'scheduler', 'briefing', 'watch']);
  await runtime.shutdown(); await runtime.shutdown();
  expect(f.stop).toHaveBeenCalledTimes(1); expect(f.exit).toHaveBeenCalledWith(0); expect(f.timer.unref).toHaveBeenCalledTimes(1);
  expect(f.events.slice(-2)).toEqual(['close', 'stop']);
 });
 it('keeps scheduled production jobs disabled for local/test startup', async () => {
  const f = fixture(); const runtime = await startApplication(f.overrides);
  expect(f.events).toEqual(['ready', 'listen', 'inbound']); expect([...f.signals.keys()]).toEqual(['SIGTERM', 'SIGINT']);
  await runtime.shutdown();
 });
});
