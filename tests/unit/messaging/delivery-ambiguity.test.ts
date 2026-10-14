import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
import * as compatibility from '../../../src/integrations/whatsapp/kapso-client.js';
import * as compiled from '../../../dist/runtime/integrations/whatsapp/kapso-client.js';
const common = { phoneNumberId: 'synthetic-channel', phoneNumber: '19995550101', bodyText: 'Observed result' };
function transportsFor({ sendWhatsAppText, sendWhatsAppCtaUrl, sendWhatsAppFlow, sendWhatsAppQuickReplyButtons, sendWhatsAppListMessage }: typeof compatibility): Array<[string, () => Promise<unknown>]> {
  return [
    ['text', () => sendWhatsAppText({ ...common, text: common.bodyText })],
    ['CTA', () => sendWhatsAppCtaUrl({ ...common, buttonText: 'Open', url: 'https://example.test' })],
    ['flow', () => sendWhatsAppFlow({ ...common, flowId: 'synthetic-flow' })],
    ['buttons', () => sendWhatsAppQuickReplyButtons({ ...common, buttons: [{ id: 'done', title: 'Done' }] })],
    ['list', () => sendWhatsAppListMessage({ ...common, buttonText: 'Open', sections: [{ title: 'Tasks', rows: [{ id: 'task-a', title: 'Alpha' }] }] })],
  ];
}
beforeEach(() => { vi.stubEnv('KAPSO_API_KEY', 'synthetic-key'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe.each([['compatibility', compatibility], ['compiled TypeScript', compiled]] as const)('ambiguous outbound delivery is never duplicated (%s)', (_name, adapter) => {
  const transports = transportsFor(adapter);
  it.each(transports)('%s does not resend as text after a possibly accepted request disconnects', async (_name, send) => {
    const fetch = untrustedResultMock(vi.spyOn(globalThis, 'fetch')).mockRejectedValueOnce(new Error('Connection closed'))
      .mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: 'duplicate' }] }) });
    await expect(send()).rejects.toMatchObject({ code: 'DELIVERY_OUTCOME_UNKNOWN' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not claim success for HTTP 200 without a provider message identity', async () => {
    const fetch = untrustedResultMock(vi.spyOn(globalThis, 'fetch')).mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(transports[1]![1]()).rejects.toMatchObject({ code: 'DELIVERY_OUTCOME_UNKNOWN' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not fall back after a provider server error', async () => {
    const fetch = untrustedResultMock(vi.spyOn(globalThis, 'fetch')).mockResolvedValue({ ok: false, status: 502, text: async () => 'upstream disconnected' });
    await expect(transports[2]![1]()).rejects.toMatchObject({ code: 'DELIVERY_OUTCOME_UNKNOWN' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retains the originating channel for a definitively rejected interactive format', async () => {
    const fetch = untrustedResultMock(vi.spyOn(globalThis, 'fetch')).mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'Unsupported interactive format' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{ id: 'accepted-text' }] }) });
    expect(await transports[1]![1]()).toMatchObject({ success: true, messageId: 'accepted-text' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url]) => String(url).includes('/synthetic-channel/messages'))).toBe(true);
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string).type).toBe('text');
  });

});
