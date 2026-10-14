import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabaseClient, type DatabaseClientOptions } from '../../../src/infrastructure/database/database-client.js';
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const env: Record<string, string | undefined> = { SUPABASE_URL: 'https://db.example.test', SUPABASE_SECRET: 'synthetic-key' };
  const transport = vi.fn<typeof fetch>(async () => new Response('{}'));
  let signal: AbortSignal | null = null;
  let options!: DatabaseClientOptions;
  const client = {};
  const createClient = vi.fn((_url: string, _secret: string, input: DatabaseClientOptions) => { options = input; return client; });
  const currentTurnSignal = vi.fn(() => signal);
  const actual = createDatabaseClient({ getEnvironment: () => env, createClient, currentTurnSignal, fetch: transport });
  return { env, transport, createClient, currentTurnSignal, actual, client, options, setSignal: (next: AbortSignal | null) => { signal = next; } };
}
describe('typed shared database client initialization', () => {
  it('constructs once with existing configuration, disables auth persistence and performs no request', () => {
    const f = fixture(); expect(f.actual).toBe(f.client); expect(f.createClient).toHaveBeenCalledExactlyOnceWith('https://db.example.test', 'synthetic-key', f.options); expect(f.options.auth).toEqual({ persistSession: false, autoRefreshToken: false }); expect(f.transport).not.toHaveBeenCalled(); expect(f.currentTurnSignal).not.toHaveBeenCalled();
    f.env.SUPABASE_URL = 'https://changed.example.test'; expect(f.createClient).toHaveBeenCalledTimes(1);
  });
  it('keeps placeholder defaults for missing or empty configuration', () => {
    for (const env of [{}, { SUPABASE_URL: '', SUPABASE_SECRET: '' }]) {
      const createClient = vi.fn(() => 'client'); expect(createDatabaseClient({ getEnvironment: () => env, createClient, currentTurnSignal: () => null, fetch })).toBe('client'); expect(createClient.mock.calls[0]).toEqual(['https://placeholder.supabase.co', 'placeholder-secret', expect.any(Object)]);
    }
  });
  it('preserves request URL/options and combines request, current lease and exact timeout signals', async () => {
    const f = fixture(); const timeout = new AbortController(); const request = new AbortController(); const lease = new AbortController(); f.setSignal(lease.signal);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal); const input = { method: 'PATCH', body: '{"status":"active"}', headers: { 'x-test': 'value' }, signal: request.signal };
    await f.options.global.fetch('https://db.example.test/rest/v1/subscriptions', input);
    expect(timeoutSpy).toHaveBeenCalledWith(15000); expect(f.currentTurnSignal).toHaveBeenCalledTimes(1); const [url, options] = f.transport.mock.calls[0]!; expect(url).toBe('https://db.example.test/rest/v1/subscriptions'); expect(options).toMatchObject({ method: 'PATCH', body: input.body, headers: input.headers }); expect(options!.signal).not.toBe(request.signal); expect(input.signal).toBe(request.signal);
    lease.abort('lease-lost'); expect(options!.signal!.aborted).toBe(true); expect(options!.signal!.reason).toBe('lease-lost');
  });
  it.each(['request', 'lease', 'timeout'] as const)('propagates %s cancellation and preserves transport rejection identity without retry', async source => {
    const f = fixture(); const controllers = { request: new AbortController(), lease: new AbortController(), timeout: new AbortController() }; f.setSignal(controllers.lease.signal); vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controllers.timeout.signal);
    const error = Error('synthetic transport failure'); f.transport.mockRejectedValue(error); await expect(f.options.global.fetch('https://db.example.test', { signal: controllers.request.signal })).rejects.toBe(error); controllers[source].abort(error); expect(f.transport.mock.calls[0]![1]!.signal!.reason).toBe(error); expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it('reads lease signals afresh, preserves already-aborted reasons and accepts absent request options', async () => {
    const f = fixture(); const timeout = new AbortController(); vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    await f.options.global.fetch('https://db.example.test'); const initial = f.transport.mock.calls[0]![1]!.signal!; const lease = new AbortController(); lease.abort('retired'); f.setSignal(lease.signal); await f.options.global.fetch('https://db.example.test'); expect(initial.aborted).toBe(false); expect(f.transport.mock.calls[1]![1]!.signal!.reason).toBe('retired'); expect(f.currentTurnSignal).toHaveBeenCalledTimes(2);
  });
});
