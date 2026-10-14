import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { KapsoClientDependencies } from '../../../src/integrations/whatsapp/kapso-client-core.js';
import { createKapsoClient } from '../../../src/integrations/whatsapp/kapso-client-core.js';
const { createClient } = createRequire(import.meta.url)('@supabase/supabase-js');
const epoch = Date.parse('2026-10-13T11:00:00Z');
function fixture() {
  const deps = { getEnv: () => ({ KAPSO_API_KEY: 'synthetic', KAPSO_PHONE_NUMBER_ID: 'origin' }), getNowMs: () => epoch,
    assertTurnLease: vi.fn(async () => {}), checkpointTurnResponse: vi.fn(async () => {}), currentTurnSignal: () => undefined,
    markAsProcessed: vi.fn(), sleep: vi.fn(async () => {}), fetch: vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.test' }] }))),
    userCache: new Map<string, { user: { last_user_message_at: string } }>(), supabase: { from: vi.fn() }, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  return { deps, ...createKapsoClient(deps as unknown as KapsoClientDependencies) };
}
describe('typed Kapso client adapters', () => {
  it('reads configuration live and retains BSUID recipient routing', async () => {
    const f = fixture(); let config = { KAPSO_API_KEY: 'first', KAPSO_PHONE_NUMBER_ID: 'phone1' }; f.deps.getEnv = () => config;
    const client = createKapsoClient(f.deps); await client.sendReminderConfirmation('CO.identity', 'Hello'); config = { KAPSO_API_KEY: 'second', KAPSO_PHONE_NUMBER_ID: 'phone2' }; await client.sendReminderConfirmation('+57 300 000 0001', 'Hola');
    expect(f.deps.fetch.mock.calls.map(call => [call[0], (call[1]!.headers as Record<string, string>)['X-API-Key'], JSON.parse(call[1]!.body as string)])).toEqual([
      ['https://api.kapso.ai/meta/whatsapp/v24.0/phone1/messages', 'first', { messaging_product: 'whatsapp', recipient: 'CO.identity', type: 'text', text: { body: 'Hello' } }],
      ['https://api.kapso.ai/meta/whatsapp/v24.0/phone2/messages', 'second', { messaging_product: 'whatsapp', to: '573000000001', type: 'text', text: { body: 'Hola' } }],
    ]);
  });
  it('retains the cached 24h inclusive boundary and scoped SDK fallback for expired cache', async () => {
    const f = fixture(); f.deps.userCache.set('573000000001', { user: { last_user_message_at: new Date(epoch - 86400000).toISOString() } }); expect(await f.isWithin24HourWindow('+573000000001')).toBe(true); expect(f.deps.supabase.from).not.toHaveBeenCalled();
    f.deps.userCache.clear(); const requests: [string, RequestInit][] = [];
    const real = createClient('https://synthetic.supabase.co', 'synthetic', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (url: string, options: RequestInit) => { requests.push([String(url), options]); return new Response('[{"id":"inbound"}]', { headers: { 'Content-Type': 'application/json' } }); } } });
    const client = createKapsoClient({ ...f.deps, supabase: real } as unknown as KapsoClientDependencies); expect(await client.isWithin24HourWindow('+573000000001')).toBe(true);
    const url = new URL(requests[0]![0]); expect(url.searchParams.get('phone_number')).toBe('in.(+573000000001,573000000001)'); expect(url.searchParams.get('created_at')).toBe('gt.2026-10-12T11:00:00.000Z'); expect(url.searchParams.get('limit')).toBe('1'); expect(url.searchParams.get('or')).toContain('reminder_ack_click');
  });
  it('limits list rows globally and preserves fallback text when the list is empty', async () => {
    const f = fixture(); const rows = Array.from({ length: 8 }, (_, i) => ({ id: `${i}`, title: 'x'.repeat(30), description: 'd'.repeat(90) }));
    await f.sendWhatsAppListMessage({ phoneNumber: '573000000001', bodyText: 'Choose', sections: [{ title: 'One', rows }, { title: 'Two', rows }] }); const payload = JSON.parse(f.deps.fetch.mock.calls[0]![1]!.body as string); expect(payload.interactive.action.sections.map((s: { rows: unknown[] }) => s.rows.length)).toEqual([8, 2]); expect(payload.interactive.action.sections[0].rows[0]).toMatchObject({ title: 'x'.repeat(24), description: 'd'.repeat(72) });
    await f.sendWhatsAppListMessage({ phoneNumber: '573000000001', bodyText: 'Empty', sections: [] }); expect(JSON.parse(f.deps.fetch.mock.calls[1]![1]!.body as string)).toMatchObject({ type: 'text', text: { body: 'Empty' } });
  });
  it('preserves flow payload and CTA labels without template replays on uncertain delivery', async () => {
    const f = fixture(); await f.sendWhatsAppFlow({ bsuid: 'CO.identity', bodyText: 'Tasks', flowId: 'flow', flowData: { ids: ['task'] } }); expect(JSON.parse(f.deps.fetch.mock.calls[0]![1]!.body as string).interactive.action.parameters).toMatchObject({ flow_id: 'flow', flow_token: `flow_${epoch}`, flow_action_payload: { screen: 'TASK_SELECTION', data: { ids: ['task'] } } });
    f.deps.fetch.mockRejectedValue(Error('network')); f.deps.userCache.set('573000000001', { user: { last_user_message_at: new Date(epoch).toISOString() } });
    const receipt = await f.sendReminderMessage('573000000001', 'Water', { language: 'en', buttons: [{ id: 'ack', title: 'Done' }] }); expect(receipt).toMatchObject({ success: false, outcome: 'unknown', code: 'DELIVERY_OUTCOME_UNKNOWN' }); expect(f.deps.fetch).toHaveBeenCalledTimes(2);
  });
  it('uses an English template outside the window and falls back to Spanish only on explicit missing-template rejection', async () => {
    const f = fixture(); f.deps.fetch.mockResolvedValueOnce(new Response('132001 does not exist in', { status: 400 }));
    await f.sendReminderMessage('573000000001', '⏰ Recordatorio: Water', { forceTemplate: true, language: 'en' });
    expect(f.deps.fetch.mock.calls.map(call => JSON.parse(call[1]!.body as string).template)).toEqual([
      { name: 'reminder_task_one_reminder_english', language: { code: 'en_US' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Water' }] }] },
      { name: 'reminder_task_one_reminder', language: { code: 'es' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Water' }] }] },
    ]);
  });
  it('skips synthetic typing messages and retains a single bounded read-status request', async () => {
    const f = fixture(); expect(await f.sendTypingIndicator('wamid.TEST_fixture')).toBeNull(); expect(f.deps.fetch).not.toHaveBeenCalled(); await f.sendTypingIndicator('wamid.inbound'); expect(f.deps.fetch).toHaveBeenCalledOnce(); expect(JSON.parse(f.deps.fetch.mock.calls[0]![1]!.body as string)).toMatchObject({ message_id: 'wamid.inbound', status: 'read', typing_indicator: { type: 'text' } }); expect(f.deps.markAsProcessed).not.toHaveBeenCalled();
  });
  it('downloads media as Blob through metadata and stops when metadata or binary fails', async () => {
    const f = fixture(); f.deps.fetch.mockResolvedValueOnce(new Response('{"download_url":"https://api.kapso.ai/media"}')).mockResolvedValueOnce(new Response('audio')); const blob = await f.downloadMedia('media', 'origin', 'https://lookaside.fbsbx.com/media'); expect(await blob!.text()).toBe('audio'); expect(f.deps.fetch.mock.calls.map(call => call[0])).toEqual(['https://api.kapso.ai/meta/whatsapp/v24.0/media?phone_number_id=origin', 'https://api.kapso.ai/media']);
    f.deps.fetch.mockClear().mockResolvedValueOnce(new Response('failed', { status: 500 })); expect(await f.downloadMedia('media')).toBeNull(); expect(f.deps.fetch).toHaveBeenCalledOnce();
  });
});
