import { describe, expect, it, vi } from 'vitest';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import { MockAIProvider } from '@templelabs/ai';
import { aiTranscriptSchema, type ReminderResult, type ToolCall } from '@templelabs/contracts';
import { createReminderTools, ToolRegistry, type ReminderDomainPort } from '@templelabs/tools';
import { WhatsAppProductivityPresenter } from '../../../src/presentation/whatsapp-productivity-presenter.js';
import { context, response } from './productivity-fixtures.js';

const read: ToolCall = { id: 'read', name: 'reminder_read', arguments: { filter: 'today' } };
const finishedRead: ToolCall = { ...read, arguments: { ...read.arguments, turnDisposition: 'finish' } };
function setup(calls: ToolCall[], options: { partial?: boolean; question?: boolean; records?: boolean; foreignReceipt?: boolean } = {}) {
  const data: ReminderResult = { operation: 'read', complete: !options.partial, coverage: 'bounded_list',
    records: options.records ? [{ id: 'owned', content: 'Salir', sendAt: '2026-10-11T21:00:00Z', recurrence: null,
      isAdvanceNotice: false, parentReminderId: null, requiresConfirmation: false, acknowledgedAt: null }] : [], rejections: [],
    presentation: { canonicalCard: null, questions: options.question ? ['¿Hoy o mañana?'] : [], cta: null } };
  const execute = vi.fn<ReminderDomainPort['execute']>(async (_request, ctx, operationId) => ({ status: options.partial ? 'partial' : 'success', data,
    observation: JSON.stringify(data), receipt: { userId: options.foreignReceipt ? 'foreign' : ctx.userId, operationId,
      toolName: 'reminder_read', resourceIds: data.records.map(record => record.id) } }));
  const provider = new MockAIProvider([{ response: response(calls) }, { response: new Error('Redundant final inference failed') }]);
  const runner = new ProductivityTurnRunner(provider, new ToolRegistry(createReminderTools({ execute })), {
    continuation: 'observation_driven', finishWithVerifiedResults: true, maxToolCalls: 5,
  });
  return { provider, execute, run: () => runner.run('Oye, ¿qué recordatorios tengo para hoy?', { ...context, capabilities: new Set(['reminders.read']) }) };
}
describe('model-requested, host-verified batch completion', () => {
  it.each([false, true])('completes a certified read without another inference, populated=%s', async records => {
    const s = setup([finishedRead], { records }); const result = await s.run();
    expect(s.provider.requests).toHaveLength(1); expect(s.execute).toHaveBeenCalledOnce();
    expect(result.uiPayload.notices).toEqual([]); expect(result.uiPayload.items).toHaveLength(1);
    expect(s.execute.mock.calls[0]?.[0]).toEqual({ operation: 'read', input: { filter: 'today' } });
    expect(result.conversation.history.find(message => message.role === 'tool')).toMatchObject({ content: { turnDisposition: 'finish' } });
    expect(aiTranscriptSchema.safeParse(result.conversation.history).success).toBe(true);
    const text = new WhatsAppProductivityPresenter().render(result.uiPayload).text;
    expect(text).not.toMatch(/No pude|estás al día por completo/i);
    if (records) expect(text).toContain('Salir');
    else { expect(text).toContain('No tienes recordatorios pendientes para hoy'); expect(text).not.toContain('lista limitada'); }
  });
  it('waits for the entire batch even when completion is requested before the read', async () => {
    const s = setup([finishedRead, { ...read, id: 'second' }]); expect((await s.run()).uiPayload.notices).toEqual([]);
    expect(s.execute).toHaveBeenCalledTimes(2); expect(s.provider.requests).toHaveLength(1);
  });
  it.each([{ partial: true }, { question: true }, { foreignReceipt: true }])('does not certify an unresolved or unowned result %j', async options => {
    const s = setup([finishedRead], options); const result = await s.run();
    expect(s.provider.requests).toHaveLength(2); expect(result.uiPayload.notices).toContain('provider_unavailable');
  });
  it('does not finish on discovery or completion alone', async () => {
    const s = setup([{ id: 'unknown', name: 'unavailable', arguments: { turnDisposition: 'finish' } }]); const result = await s.run();
    expect(s.execute).not.toHaveBeenCalled(); expect(s.provider.requests).toHaveLength(2);
    expect(result.uiPayload.items).toEqual([]); expect(result.uiPayload.notices).toContain('provider_unavailable');
  });
  it('keeps observation-driven reasoning when the model does not request completion', async () => {
    const s = setup([read]); const result = await s.run();
    expect(s.provider.requests).toHaveLength(2); expect(result.uiPayload.notices).toContain('provider_unavailable');
  });
  it('rejects completion arguments instead of hiding an invalid response', async () => {
    const s = setup([{ ...read, arguments: { ...read.arguments, turnDisposition: 'invented' } }]);
    expect((await s.run()).uiPayload.notices).toContain('invalid_response');
  });
});
