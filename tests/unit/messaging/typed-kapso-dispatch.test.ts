import { describe, expect, it, vi } from 'vitest';
import { createKapsoDispatch, type KapsoDispatchResult } from '../../../src/integrations/whatsapp/kapso-dispatch.js';
import { KapsoError, KapsoValidationError } from '../../../src/integrations/whatsapp/kapso-errors.js';
function fixture(responses: (Response | Error)[] = []) {
  let signal: AbortSignal | undefined;
  const deps = { assertTurnLease: vi.fn(async () => {}), checkpointTurnResponse: vi.fn(async (_value: unknown) => {}), currentTurnSignal: (): AbortSignal | undefined => signal, fetch: vi.fn<typeof fetch>(async () => { const response = responses.shift(); if (response instanceof Error) throw response; if (!response) throw Error('unexpected request'); return response; }), markAsProcessed: vi.fn(), sleep: vi.fn(async (_milliseconds: number) => {}), sendWhatsAppText: vi.fn(async (): Promise<KapsoDispatchResult> => ({ success: true, messageId: 'fallback', recipientType: 'phone', data: {} })) };
  return { deps, setSignal: (value: AbortSignal) => { signal = value; }, ...createKapsoDispatch(deps) };
}
const input = { activePhoneId: 'phone-id', apiKey: 'synthetic-key', payload: { to: '573000000001', text: { body: 'Confirmed task' }, type: 'text' } };
const receipt = () => new Response(JSON.stringify({ messages: [{ id: 'wamid.accepted' }] }), { status: 200 });
describe('typed Kapso dispatch boundary', () => {
  it('constructs without effects and checkpoints an attempt before a fenced send and owned receipt', async () => {
    const f = fixture([receipt()]); expect(f.deps.fetch).not.toHaveBeenCalled(); expect(await f.postMessage(input)).toMatchObject({ success: true, messageId: 'wamid.accepted', recipientType: 'phone' }); expect(f.deps.checkpointTurnResponse.mock.calls.map(call => call[0])).toEqual([{ confirmation: 'Confirmed task', delivery: { status: 'attempted' } }, { delivery: { status: 'accepted', messageId: 'wamid.accepted' } }]); expect(f.deps.assertTurnLease).toHaveBeenCalledTimes(2); expect(f.deps.fetch).toHaveBeenCalledWith('https://api.kapso.ai/meta/whatsapp/v24.0/phone-id/messages', expect.objectContaining({ method: 'POST', body: JSON.stringify(input.payload) })); expect(f.deps.markAsProcessed).toHaveBeenCalledExactlyOnceWith('wamid.accepted');
  });
  it.each([Error('network'), new Response('broken', { status: 200 }), new Response('{}', { status: 200 }), new Response('server', { status: 503 })])('does not retry uncertain delivery or missing identities', async response => {
    const f = fixture([response]); await expect(f.postMessage({ ...input, fallbackText: 'Fallback' })).rejects.toMatchObject({ code: 'DELIVERY_OUTCOME_UNKNOWN' }); expect(f.deps.fetch).toHaveBeenCalledTimes(1); expect(f.deps.sleep).not.toHaveBeenCalled(); expect(f.deps.sendWhatsAppText).not.toHaveBeenCalled(); expect(f.deps.markAsProcessed).not.toHaveBeenCalled();
  });
  it('retains bounded exponential waits only for explicit 429 rejections', async () => {
    const f = fixture([new Response('', { status: 429 }), new Response('', { status: 429 }), new Response('', { status: 429 }), receipt()]); await f.postMessage(input); expect(f.deps.sleep.mock.calls.map(call => call[0])).toEqual([1000, 2000, 4000]); expect(f.deps.fetch).toHaveBeenCalledTimes(4); expect(f.deps.assertTurnLease).toHaveBeenCalledTimes(5);
  });
  it('stops after the existing retry cap and never performs an unknown fifth request', async () => {
    const f = fixture(Array.from({ length: 4 }, () => new Response('', { status: 429 }))); await expect(f.postMessage(input)).rejects.toMatchObject({ code: 'RATE_LIMIT' }); expect(f.deps.fetch).toHaveBeenCalledTimes(4); expect(f.deps.sleep).toHaveBeenCalledTimes(3);
  });
  it('retains explicit format fallback and owned error class identity', async () => {
    const f = fixture([new Response('bad format', { status: 422 })]); expect(await f.postMessage({ ...input, fallbackText: 'Fallback' })).toMatchObject({ messageId: 'fallback' }); expect(f.deps.sendWhatsAppText).toHaveBeenCalledWith({ phoneNumberId: 'phone-id', phoneNumber: '573000000001', bsuid: undefined, text: 'Fallback' }); const failed = fixture([new Response('', { status: 400 })]); await expect(failed.postMessage(input)).rejects.toBeInstanceOf(KapsoValidationError);
  });
  it('does not send after a failed lease/checkpoint, including before a retry', async () => {
    const f = fixture([new Response('', { status: 429 })]); const error = Error('lease lost'); f.deps.assertTurnLease.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(error); await expect(f.postMessage(input)).rejects.toBe(error); expect(f.deps.fetch).toHaveBeenCalledTimes(1); const blocked = fixture(); blocked.deps.checkpointTurnResponse.mockRejectedValue(error); await expect(blocked.postMessage(input)).rejects.toBe(error); expect(blocked.deps.fetch).not.toHaveBeenCalled();
  });
  it('retains BSUID selection, composed lease cancellation and typed error properties', async () => {
    const controller = new AbortController(); const f = fixture([receipt()]); f.setSignal(controller.signal); const result = await f.postMessage({ ...input, payload: { recipient: 'CO.identity', text: { body: 'Text' } } }); expect(result.recipientType).toBe('bsuid'); controller.abort('retired'); expect(f.deps.fetch.mock.calls[0]![1]!.signal!.reason).toBe('retired'); const error = new KapsoError('message', { status: 500, code: 'code', data: { value: true } }); expect(error).toMatchObject({ name: 'KapsoError', status: 500, code: 'code', data: { value: true } });
  });
});
