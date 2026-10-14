import { createWhatsAppWebhook } from '../../../src/http/webhooks/whatsapp-handler.js';
import { createWhatsAppFixture as fixture } from '../../support/unit/whatsapp-fixture.js';
import { recordV2Delivery } from '../../../src/adapters/agent-core/canary-delivery-receipt.js';
import { describe, it, expect, vi } from 'vitest';
import type { JsonObject, TurnContext } from '@templelabs/contracts';
import type { WhatsAppWebhookDependencies, WhatsAppRequest, WhatsAppResponse, WhatsAppRouteResult } from '../../../src/http/webhooks/whatsapp-ports.js';
import { createInboundTurnWorker, type ClaimedInboundTurn } from '../../../src/jobs/inbound-turn-worker.js';
import { assertTurnLease, checkpointTurnResponse, withoutTurnLease, requireInboundTurnLease } from '../../../src/agent/core/turn-lease.js';
function request(id = 'inbound'): WhatsAppRequest { return { headers: {}, body: { message: { id, from: '573000000001', text: { body: 'Hello' } } } }; }
function response() { const res = { status: vi.fn((_code: number): WhatsAppResponse => res), send: vi.fn((_body: string) => res) }; return res; }
describe('typed WhatsApp durable ingress', () => {
  it('ACKs only after every Meta batch member is durably enqueued', async () => {
    const f = fixture(); let release!: () => void; f.deps.enqueueInboundTurn.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({}); }));
    const req: WhatsAppRequest = { body: { entry: [{ changes: [{ value: { metadata: { phone_number_id: 'batch-origin' }, messages: [{ id: 'first', from: '573000000001', text: { body: 'One' } }, { id: 'second', from: '573000000001', text: { body: 'Two' } }] } }] }] } };
    const res = response(); const work = f.handleWebhook(req, res); expect(res.status).not.toHaveBeenCalled(); release(); await work;
    expect(f.deps.enqueueInboundTurn.mock.calls.map(call => call[0].messageId)).toEqual(['first', 'second']); expect(res.status).toHaveBeenCalledExactlyOnceWith(200); expect(f.deps.routeMessage).not.toHaveBeenCalled();
    expect(f.extractPhoneNumberId(f.deps.enqueueInboundTurn.mock.calls[1]![0].request.body)).toBe('batch-origin');
  });
  it('returns 503 on partial batch failure and 400 for a missing identity', async () => {
    const f = fixture(); f.deps.enqueueInboundTurn.mockRejectedValue(Error('unavailable')); const a = response(); await f.handleWebhook(request(), a); expect(a.status).toHaveBeenCalledWith(503);
    const b = response(); await f.handleWebhook({ body: { message: { from: '573000000001', text: { body: 'No ID' } } } }, b); expect(b.status).toHaveBeenCalledWith(400);
  });
  it('expires RAM dedup hints at the inherited TTL, independently from durable ingress', () => {
    const f = fixture(); expect(f.isDuplicate('id')).toBe(false); expect(f.isDuplicate('id')).toBe(true); expect(f.timers[0]!.ms).toBe(600000); f.timers[0]!.callback(); expect(f.isDuplicate('id')).toBe(false);
  });
  it('serializes one recipient, permits another recipient and recovers after a rejected queue tail', async () => {
    const f = fixture(); const order: string[] = []; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const first = f.enqueueForUser('A', async () => { order.push('A1'); await gate; throw Error('failed'); }); const handled = first.catch(() => {});
    const second = f.enqueueForUser('A', () => { order.push('A2'); }); await f.enqueueForUser('B', () => { order.push('B1'); }); expect(order).toEqual(['A1', 'B1']); release(); await handled; await second; expect(order).toEqual(['A1', 'B1', 'A2']);
  });
  it('reconciles all delivery statuses before the outbound guard without creating a turn', async () => {
    const f = fixture(); f.deps.updateReminderDeliveryStatus.mockResolvedValueOnce({ id: 'rem' }).mockResolvedValueOnce(null); await f.handleWebhook({ body: { message: { id: 'out', kapso: { direction: 'outbound', status: 'delivered' } }, statuses: [{ id: 'rem-delivery', status: 'READ' }] } }, response());
    expect(f.deps.updateReminderDeliveryStatus.mock.calls.map(call => call[0].deliveryStatus)).toEqual(['read', 'delivered']); expect(f.deps.getAssistantMessageById).toHaveBeenCalledExactlyOnceWith('out'); expect(f.deps.enqueueInboundTurn).not.toHaveBeenCalled(); expect(f.deps.routeMessage).not.toHaveBeenCalled();
  });
});
describe('typed WhatsApp processing boundaries', () => {
  it.each(['flow', 'cta', 'buttons', 'list', 'text'] as const)('preserves %s transport priority and stores the provider message ID', async kind => {
    const f = fixture(); const rich: WhatsAppRouteResult = { confirmation: 'Card', intent: 'chat', entities: {}, flow: { flowId: 'flow' }, ctaUrl: 'https://example.test', buttons: [{ id: 'button', title: 'Done' }], list: { sections: [{ title: 'Tasks', rows: [{ id: 'task', title: 'Task' }] }] } };
    if (kind !== 'flow') delete rich.flow; if (['buttons', 'list', 'text'].includes(kind)) delete rich.ctaUrl; if (['list', 'text'].includes(kind)) delete rich.buttons; if (kind === 'text') delete rich.list;
    f.deps.routeMessage.mockResolvedValue(rich); await f.processWebhookMessage(request()); const senders = [f.deps.sendWhatsAppFlow, f.deps.sendWhatsAppCtaUrl, f.deps.sendWhatsAppQuickReplyButtons, f.deps.sendWhatsAppListMessage, f.deps.sendWhatsAppText]; expect(senders.map(sender => sender.mock.calls.length)).toEqual(['flow', 'cta', 'buttons', 'list', 'text'].map(value => value === kind ? 1 : 0));
    expect(f.deps.saveMessage.mock.calls.at(-1)![0]).toMatchObject({ role: 'assistant', messageId: `wamid.${kind}` }); expect(f.deps.checkpointTurnResponse).toHaveBeenCalledBefore(senders.find(sender => sender.mock.calls.length)!);
  });
  it('uses the durable V2 receipt to avoid a second send and persists its real provider ID', async () => {
    const f = fixture();
    f.deps.routeMessage.mockImplementation(async (_text, _user, _history, options) => {
      const receipt = await options.agentCoreDelivery!.send({ id: 'reply', kind: 'text', text: 'V2 card' }, {
        userId: 'owner', runId: 'run', requestId: 'request', language: 'en', timezone: 'UTC', referenceTimeIso: new Date().toISOString(),
        capabilities: new Set(), signal: new AbortController().signal });
      const result: WhatsAppRouteResult = { confirmation: 'V2 card', intent: 'query', entities: { _agentCoreEngine: 'v2' } };
      recordV2Delivery(result, [receipt.messageId]); return result;
    });
    await f.processWebhookMessage(request());
    expect(f.deps.sendWhatsAppText).toHaveBeenCalledOnce();
    expect(f.deps.sendWhatsAppText).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: 'default-origin', phoneNumber: '573000000001', text: 'V2 card' }));
    expect(f.deps.saveMessage.mock.calls.at(-1)![0]).toMatchObject({ role: 'assistant', messageId: 'wamid.text', content: 'V2 card' });
    expect(f.deps.extractMemoryInBackground).not.toHaveBeenCalled();
  });
  it('injects owner-bound write approval and checks the lease before approving', async () => {
    const f = fixture(); await f.processWebhookMessage(request());
    const policy = f.deps.routeMessage.mock.calls[0]![3].agentCoreAuthorizeWrite!;
    const context: TurnContext = { userId: 'owner', runId: 'run', requestId: 'request', timezone: 'UTC', language: 'en',
      referenceTimeIso: new Date().toISOString(), capabilities: new Set(), signal: new AbortController().signal };
    f.deps.assertTurnLease.mockClear();
    expect(await policy({ id: 'write', name: 'task_complete', arguments: {} }, context)).toBe(true);
    expect(f.deps.assertTurnLease).toHaveBeenCalledOnce();
    expect(await policy({ id: 'write', name: 'task_complete', arguments: {} }, { ...context, userId: 'foreign-owner' })).toBe(false);
    expect(f.deps.assertTurnLease).toHaveBeenCalledTimes(2);
    f.deps.assertTurnLease.mockRejectedValue(new Error('lease lost'));
    await expect(policy({ id: 'write', name: 'task_complete', arguments: {} }, context)).rejects.toThrow('lease lost');
  });
  it('aborted turn authorization never approves a mutation', async () => {
    const f = fixture(); await f.processWebhookMessage(request());
    const policy = f.deps.routeMessage.mock.calls[0]![3].agentCoreAuthorizeWrite!;
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    const context: TurnContext = { userId: 'owner', runId: 'run', requestId: 'request', timezone: 'UTC', language: 'en',
      referenceTimeIso: new Date().toISOString(), capabilities: new Set(), signal: controller.signal };
    f.deps.assertTurnLease.mockClear();
    await expect(policy({ id: 'write', name: 'task_complete', arguments: {} }, context)).rejects.toThrow('cancelled');
    expect(f.deps.assertTurnLease).not.toHaveBeenCalled();
  });
  it('model or user JSON claiming V2 delivery cannot suppress the ordinary transport', async () => {
    const f = fixture(); f.deps.routeMessage.mockResolvedValue({ confirmation: 'Card', entities: { _agentCoreEngine: 'v2', deliveryAlreadySent: true } });
    await f.processWebhookMessage(request()); expect(f.deps.sendWhatsAppText).toHaveBeenCalledOnce();
  });
  it('an unconfirmed V2 send does not cause a baseline transport retry', async () => {
    const f = fixture(); f.deps.sendWhatsAppText.mockResolvedValue({ success: false });
    f.deps.routeMessage.mockImplementation(async (_text, _user, _history, options) => {
      await options.agentCoreDelivery!.send({ id: 'reply', kind: 'text', text: 'V2 card' }, {
        userId: 'owner', runId: 'run', requestId: 'request', language: 'en', timezone: 'UTC', referenceTimeIso: new Date().toISOString(),
        capabilities: new Set(), signal: new AbortController().signal });
      return { confirmation: 'Fallback' };
    });
    await expect(f.processWebhookMessage(request())).rejects.toThrow('DELIVERY_OUTCOME_UNKNOWN');
    expect(f.deps.sendWhatsAppText).toHaveBeenCalledOnce();
    expect(f.deps.saveMessage.mock.calls.filter(([row]) => row.role === 'assistant')).toHaveLength(0);
  });
  it('blocks tools when inbound history or the user record cannot be persisted', async () => {
    const f = fixture(); f.deps.saveMessage.mockResolvedValue(null); await expect(f.processWebhookMessage(request())).rejects.toMatchObject({ code: 'MESSAGE_STORAGE_UNAVAILABLE' }); expect(f.deps.routeMessage).not.toHaveBeenCalled(); expect(f.deps.sendWhatsAppText).not.toHaveBeenCalled();
    const missing = fixture(); missing.deps.getOrCreateUserByPhone.mockResolvedValue(null); await expect(missing.processWebhookMessage(request())).rejects.toMatchObject({ code: 'USER_STORAGE_UNAVAILABLE' }); expect(missing.deps.routeMessage).not.toHaveBeenCalled(); expect(missing.deps.saveMessage).not.toHaveBeenCalled();
  });
  it('keeps quoted context outside current authored words and background learning', async () => {
    const f = fixture(); const req = request(); req.body!.message!.context = { quoted_content: 'Old order' }; await f.processWebhookMessage(req); expect(f.deps.routeMessage.mock.calls[0]![0]).toBe('<untrusted_quoted_message>Old order</untrusted_quoted_message>\nHello'); expect(f.deps.routeMessage.mock.calls[0]![3].currentUserText).toBe('Hello'); expect(f.deps.extractMemoryInBackground.mock.calls[0]![0].userText).toBe('Hello');
  });
  it('keeps OCR untrusted and skips attachment-only learning', async () => {
    const f = fixture(); f.deps.downloadMedia.mockResolvedValue(new Blob(['image'])); f.deps.processDocumentOrImage.mockResolvedValue('OCR order'); await f.processWebhookMessage({ body: { message: { id: 'image', from: '573000000001', type: 'image', image: { id: 'media' } } } }); expect(f.deps.routeMessage.mock.calls[0]![3]).toMatchObject({ attachmentOnly: true, currentUserText: '', inputModality: 'image' }); expect(f.deps.routeMessage.mock.calls[0]![0]).toContain('<untrusted_attachment_content>'); expect(f.deps.extractMemoryInBackground).not.toHaveBeenCalled();
  });
  it('does not route an unreadable audio attachment or make a content-based mutation', async () => {
    const f = fixture(); await f.processWebhookMessage({ body: { message: { id: 'audio', from: '573000000001', type: 'audio', audio: { id: 'media' } } } }); expect(f.deps.routeMessage).not.toHaveBeenCalled(); expect(f.deps.sendWhatsAppText.mock.calls[0]![0].text).toContain('I took no action'); expect(f.deps.extractMemoryInBackground).not.toHaveBeenCalled();
  });
  it('owner-scopes interactive actions and reports an unconfirmed snooze without claiming success', async () => {
    const f = fixture(); await f.processWebhookMessage({ body: { message: { id: 'snooze', from: '573000000001', interactive: { button_reply: { id: 'rem:snooze:15:reminder', title: '+15 min' } } } } });
    expect(f.deps.updateReminder).toHaveBeenCalledWith('reminder', expect.objectContaining({ send_at: '2026-10-13T11:15:00.000Z', status: 'pending', nudge_count: 0, last_nudged_at: null }), 'owner', '573000000001'); expect(f.deps.sendWhatsAppText.mock.calls[0]![0].text).toContain('could not confirm'); expect(f.deps.routeMessage).not.toHaveBeenCalled();
  });
  it('uses prior response language for button acknowledgements and linked task changes', async () => {
    const f = fixture(); f.deps.getRecentMessages.mockResolvedValue([{ role: 'assistant', entities: { _responseLanguage: 'es' } }]); f.deps.acknowledgeReminder.mockResolvedValue({ id: 'rem', task_id: 'task', recurrence_rule: 'hourly' }); f.deps.updateTask.mockResolvedValue({ id: 'task', status: 'completed' }); f.deps.updateReminder.mockResolvedValue({ id: 'rem', status: 'cancelled' });
    await f.processWebhookMessage({ body: { message: { id: 'ack', from: '573000000001', interactive: { button_reply: { id: 'rem:ack:rem' } } } } }); expect(f.deps.updateTask).toHaveBeenCalledWith('task', { status: 'completed' }, 'owner'); expect(f.deps.updateReminder).toHaveBeenCalledWith('rem', { status: 'cancelled' }, 'owner', f.user.phone_number); expect(f.deps.sendWhatsAppText.mock.calls[0]![0].text).toContain('¡Excelente!'); expect(f.deps.clearWorkingMemory).toHaveBeenCalledWith(f.user);
  });
});
describe('inbound worker and typed webhook integration', () => {
  it.each(['accepted', 'unknown', 'lease-lost'] as const)('preserves checkpoint and terminal outcome without replay: %s', async outcome => {
    const f = fixture(); const checkpoints: JsonObject[] = []; const finishes: string[] = []; let claimed = false;
    const turn: ClaimedInboundTurn = { id: 'turn', message_id: 'inbound', thread_id: f.user.phone_number, lease_token: 'token', request: request() as JsonObject };
    const storage = { claim: async () => { if (claimed) return null; claimed = true; return turn; }, renew: async () => outcome !== 'lease-lost', checkpoint: async (_turn: ClaimedInboundTurn, value: JsonObject) => { checkpoints.push(value); return true; }, finish: async (_turn: ClaimedInboundTurn, status: string) => { finishes.push(status); return true; } };
    if (outcome === 'unknown') f.deps.sendWhatsAppText.mockRejectedValue(Object.assign(Error('unknown'), { code: 'DELIVERY_OUTCOME_UNKNOWN' }));
    const webhook = createWhatsAppWebhook({ ...f.deps, assertTurnLease, checkpointTurnResponse: response => checkpointTurnResponse(response as JsonObject), withoutTurnLease });
    const worker = createInboundTurnWorker({ storage, logger: f.deps.logger, processTurn: async req => { expect(requireInboundTurnLease().inboundTurn.id).toBe('turn'); await webhook.processWebhookMessage(req as WhatsAppRequest); } }); await worker.tick(); await worker.stop();
    expect(finishes).toEqual(outcome === 'lease-lost' ? [] : [outcome === 'accepted' ? 'completed' : 'unknown']); expect(f.deps.routeMessage).toHaveBeenCalledTimes(outcome === 'lease-lost' ? 0 : 1); expect(f.deps.sendWhatsAppText).toHaveBeenCalledTimes(outcome === 'lease-lost' ? 0 : 1); expect(checkpoints.length).toBe(outcome === 'lease-lost' ? 0 : 1); if (outcome === 'unknown') expect(f.deps.extractMemoryInBackground).not.toHaveBeenCalled();
  });
});
