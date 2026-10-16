import { describe, expect, it, vi } from 'vitest';
import { MockAIProvider, estimateBoundedInput } from '@templelabs/ai';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import { createAgendaTools, createTaskTools, createCalendarTools, createReminderTools, ToolRegistry,
  type TaskDomainPort, type CalendarDomainPort, type ReminderDomainPort } from '@templelabs/tools';
import { agendaResultSchema, calendarResultSchema, taskResultSchema, reminderResultSchema,
  productivityCheckpointSchema, type AIResponse } from '@templelabs/contracts';
import { WhatsAppProductivityPresenter } from '../../../src/presentation/whatsapp-productivity-presenter.js';
import { DurableProductivityAssistant } from '../../../src/adapters/agent-core/durable-productivity-assistant.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';
import { setup, context } from './productivity-fixtures.js';
import { productivityBudget } from '../../../src/adapters/agent-core/productivity-budget.js';

const presentation = { canonicalCard: null, questions: [], cta: null };
const ctx = { ...context, referenceTimeIso: '2026-10-15T01:49:00Z',
  capabilities: new Set([...context.capabilities, 'agenda.read', 'reminders.read']) };
const calendar = calendarResultSchema.parse({ operation: 'read', complete: true, coverage: 'bounded_list',
  events: [{ id: 'event', kind: 'timed', summary: 'Daily', startIso: '2026-10-15T14:00:00Z', endIso: '2026-10-15T15:00:00Z', meetLink: null }],
  connection: 'connected', companion: 'not_requested', issues: [], presentation });
const tasks = taskResultSchema.parse({ operation: 'read', complete: true, coverage: 'bounded_list',
  records: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Enviar propuesta', description: null, priority: null,
    status: 'pending', dueDateIso: '2026-10-15T16:00:00Z', entityId: null, entityName: null }], flow: null, issues: [], presentation });
const reminders = reminderResultSchema.parse({ operation: 'read', complete: true, coverage: 'bounded_list',
  records: [{ id: '22222222-2222-4222-8222-222222222222', content: 'Llegada al aeropuerto', sendAt: '2026-10-15T15:00:00Z',
    recurrence: null, isAdvanceNotice: false, parentReminderId: null, requiresConfirmation: false, acknowledgedAt: null }], rejections: [], presentation });
function fixture() {
  const calendarRead = vi.fn<CalendarDomainPort['execute']>(async (_request, context, operationId) => ({ status: 'success', data: structuredClone(calendar),
    receipt: { userId: context.userId, operationId, toolName: 'calendar_read', resourceIds: ['event'] }, observation: JSON.stringify(calendar) }));
  const taskRead = vi.fn<TaskDomainPort['execute']>(async (_request, context, operationId) => ({ status: 'success', data: structuredClone(tasks),
    receipt: { userId: context.userId, operationId, toolName: 'task_read', resourceIds: tasks.records.map(record => record.id) }, observation: JSON.stringify(tasks) }));
  const reminderRead = vi.fn<ReminderDomainPort['execute']>(async (_request, context, operationId) => ({ status: 'success', data: structuredClone(reminders),
    receipt: { userId: context.userId, operationId, toolName: 'reminder_read', resourceIds: reminders.records.map(record => record.id) }, observation: JSON.stringify(reminders) }));
  const atomic = new ToolRegistry([...createCalendarTools({ execute: calendarRead }), ...createTaskTools({ execute: taskRead }),
    ...createReminderTools({ execute: reminderRead })]);
  const tool = createAgendaTools(atomic)[0];
  const registry = new ToolRegistry([tool]);
  return { calendarRead, taskRead, reminderRead, tool, registry };
}
function render(data: unknown, status: 'success' | 'partial', language: 'es' | 'en' = 'es') {
  return new WhatsAppProductivityPresenter().render({ language, timezone: ctx.timezone, notices: [], items: [
    { domain: 'agenda', toolName: 'agenda_read', callId: 'aggregate', status, code: null,
      readScope: { scope: 'tomorrow' }, result: agendaResultSchema.parse(data) },
  ] }).text;
}

describe('combined owned agenda', () => {
  it('consults all three sources for one local date before completing a durable WhatsApp response', async () => {
    const f = fixture(), s = setup();
    const response: AIResponse = { message: { role: 'assistant', content: '', toolCalls: [
      { id: 'agenda', name: 'agenda_read', arguments: { scope: 'tomorrow', turnDisposition: 'finish' } },
    ] }, stopReason: 'tool_calls', usage: { inputTokens: 900, outputTokens: 80 } };
    const provider = new MockAIProvider([{ response }], () => 100);
    const runner = new ProductivityTurnRunner(provider, f.registry, { ...productivityBudget, initialTools: ['agenda_read'],
      continuation: 'observation_driven', discoverTools: true, compactObservations: true, estimateInputTokens: estimateBoundedInput, now: () => 100, maxModelSteps: 1 });
    const assistant = new DurableProductivityAssistant(runner, { send: s.send });
    const result = await withTurnLease(s.lease, () => assistant.handle('que tenemos para mañana', ctx, 'thread'));
    expect(result.uiPayload.notices).toEqual([]);
    expect(result.uiPayload.items.map(item => item.domain)).toEqual(['calendar', 'reminders', 'tasks']);
    expect(result.uiPayload.items.every(item => item.status === 'success' && item.result?.complete)).toBe(true);
    expect(result.reply.text).toContain('Daily');
    expect(result.reply.text).toContain('Llegada al aeropuerto');
    expect(result.reply.text).toContain('Enviar propuesta');
    expect(result.conversation.events).toHaveLength(1);
    expect(result.conversation.reminders).toHaveLength(1);
    expect(result.conversation.tasks).toHaveLength(1);
    expect(f.calendarRead.mock.calls[0]?.[0]).toEqual({ operation: 'read', input: { scope: '2026-10-15' } });
    expect(f.reminderRead.mock.calls[0]?.[0]).toEqual({ operation: 'read', input: { filter: '2026-10-15' } });
    expect(f.taskRead.mock.calls[0]?.[0]).toEqual({ operation: 'read', input: { scope: '2026-10-15', status: 'pending', limit: 5 } });
    expect(provider.requests).toHaveLength(1);
    expect(s.send).toHaveBeenCalledTimes(1);
    const checkpoint = productivityCheckpointSchema.parse(s.snapshot().agentCoreProductivity);
    expect(checkpoint.phase).toBe('completed');
    expect(checkpoint.effects.map(effect => effect.call?.name)).toEqual(['calendar_read', 'reminder_read', 'task_read']);
  });

  it('retains reminders and tasks when Calendar fails and explicitly reports incomplete coverage', async () => {
    const f = fixture(); f.calendarRead.mockRejectedValueOnce(new Error('Disconnected'));
    const outcome = await f.tool.execute({ scope: 'tomorrow' }, ctx, 'aggregate');
    expect(outcome.status).toBe('partial');
    if (!('data' in outcome)) throw new Error('Missing aggregate evidence');
    const text = render(outcome.data, 'partial');
    expect(text).toContain('No pude verificar Google Calendar');
    expect(text).toContain('Llegada al aeropuerto'); expect(text).toContain('Enviar propuesta');
    expect(text).not.toContain('Daily');
  });

  it.each([
    ['es', 'No pude verificar recordatorios. La agenda está incompleta.'],
    ['en', 'I could not verify reminders. The agenda is incomplete.'],
  ] as const)('identifies an unavailable reminder source in %s without discarding healthy sources', async (language, warning) => {
    const f = fixture(); f.reminderRead.mockRejectedValueOnce(new Error('Disconnected'));
    const outcome = await f.tool.execute({ scope: 'tomorrow' }, ctx, 'aggregate');
    expect(outcome.status).toBe('partial');
    if (!('data' in outcome)) throw new Error('Missing aggregate evidence');
    expect(outcome.data.complete).toBe(false);
    expect(outcome.data.sections.find(section => section.domain === 'reminders')).toMatchObject({
      status: 'failed', code: 'AGENDA_SOURCE_UNAVAILABLE', result: null,
    });
    const text = render(outcome.data, 'partial', language);
    expect(text.split(warning)).toHaveLength(2);
    expect(text).toContain('Daily');
    expect(text).toContain('Enviar propuesta');
    expect(text).not.toContain('Llegada al aeropuerto');
    expect(text).not.toContain(language === 'es' ? 'No pude completar esta acción.' : 'I could not complete this action.');
    expect(f.calendarRead).toHaveBeenCalledTimes(1);
    expect(f.taskRead).toHaveBeenCalledTimes(1);
    expect(f.reminderRead).toHaveBeenCalledTimes(1);
  });

  it('preserves standalone reminder failure presentation outside the agenda contract', () => {
    const reply = new WhatsAppProductivityPresenter().render({ language: 'es', timezone: ctx.timezone, notices: [], items: [
      { domain: 'reminders', toolName: 'reminder_read', callId: 'standalone', status: 'failed', code: 'READ_UNAVAILABLE',
        result: null, readScope: { filter: 'upcoming' } },
    ] });
    expect(reply.text).toBe('No pude completar esta acción.');
    expect(reply.ctas).toEqual([]);
    expect(reply.flows).toEqual([]);
  });

  it('preserves source domains in the next model request after a combined agenda read', async () => {
    const f = fixture();
    const response: AIResponse = { message: { role: 'assistant', content: '', toolCalls: [
      { id: 'agenda', name: 'agenda_read', arguments: { scope: 'tomorrow' } },
    ] }, stopReason: 'tool_calls', usage: { inputTokens: 100, outputTokens: 20 } };
    const provider = new MockAIProvider([{ response }, { response: { message: { role: 'assistant', content: '', toolCalls: [] },
      stopReason: 'completed', usage: { inputTokens: 100, outputTokens: 20 } } }], () => 100);
    const runner = new ProductivityTurnRunner(provider, f.registry, { compactObservations: true,
      continuation: 'observation_driven', maxModelSteps: 2, maxToolCalls: 5, now: () => 100 });
    const result = await runner.run('Consulta mañana y después completa la tarea Enviar propuesta', ctx);
    expect(provider.requests).toHaveLength(2);
    const projected = JSON.parse(JSON.stringify(provider.requests[1]!.messages.find(message => message.role === 'tool')?.content));
    expect(projected.observation.records).toEqual([
      { id: 'event', domain: 'calendar', title: 'Daily', time: '2026-10-15T14:00:00Z' },
      { id: reminders.records[0]!.id, domain: 'reminders', title: 'Llegada al aeropuerto', time: '2026-10-15T15:00:00Z' },
      { id: tasks.records[0]!.id, domain: 'tasks', title: 'Enviar propuesta', time: '2026-10-15T16:00:00Z' },
    ]);
    expect(result.uiPayload.items.map(item => [item.domain, item.status])).toEqual([
      ['calendar', 'success'], ['reminders', 'success'], ['tasks', 'success'],
    ]);
    expect(result.conversation.tasks).toEqual(tasks.records);
    expect(result.conversation.reminders).toEqual(reminders.records);
    expect(result.conversation.events).toEqual(calendar.events);
    expect(f.calendarRead).toHaveBeenCalledTimes(1);
    expect(f.taskRead).toHaveBeenCalledTimes(1);
    expect(f.reminderRead).toHaveBeenCalledTimes(1);
  });

  it('completes a partial read delivery without locking out the following turn', async () => {
    const f = fixture(), s = setup(); f.calendarRead.mockRejectedValueOnce(new Error('Disconnected'));
    const provider = new MockAIProvider([
      { response: { message: { role: 'assistant', content: '', toolCalls: [{ id: 'agenda', name: 'agenda_read', arguments: { scope: 'tomorrow', turnDisposition: 'finish' } }] }, stopReason: 'tool_calls', usage: { inputTokens: 800, outputTokens: 80 } } },
      ...['Una fuente no estuvo disponible.', 'De nada.'].map(content => ({ response: { message: { role: 'assistant' as const, content, toolCalls: [] },
        stopReason: 'completed' as const, usage: { inputTokens: 800, outputTokens: 80 } } })),
    ], () => 100);
    const runner = new ProductivityTurnRunner(provider, f.registry, { ...productivityBudget, initialTools: ['agenda_read'],
      continuation: 'observation_driven', discoverTools: true, compactObservations: true, now: () => 100, estimateInputTokens: estimateBoundedInput });
    const assistant = new DurableProductivityAssistant(runner, { send: s.send });
    const result = await withTurnLease(s.lease, () => assistant.handle('que tenemos para mañana', ctx, 'thread'));
    expect(result.requiresReconciliation).toBe(false);
    expect(result.reply.text).toContain('La agenda está incompleta');
    expect(productivityCheckpointSchema.parse(s.snapshot().agentCoreProductivity).phase).toBe('completed');
    const next = await runner.run('gracias', { ...ctx, runId: 'next', requestId: 'next' }, result.conversation);
    expect(next.conversationReply).toBe('De nada.');
    expect(next.uiPayload.notices).toEqual([]);
  });

  it('never queries a source without its capability', async () => {
    const f = fixture(), capabilities = new Set(ctx.capabilities); capabilities.delete('calendar.read');
    const outcome = await f.tool.execute({ scope: 'tomorrow' }, { ...ctx, capabilities }, 'aggregate');
    expect(outcome.status).toBe('partial');
    expect(f.calendarRead).not.toHaveBeenCalled();
    expect(f.reminderRead).toHaveBeenCalledTimes(1); expect(f.taskRead).toHaveBeenCalledTimes(1);
  });

  it('rejects foreign receipt identity while retaining other owned sources', async () => {
    const f = fixture();
    f.calendarRead.mockResolvedValueOnce({ status: 'success', data: calendar, observation: '{}',
      receipt: { userId: 'foreign', operationId: 'aggregate:calendar', toolName: 'calendar_read', resourceIds: ['event'] } });
    const outcome = await f.tool.execute({ scope: 'tomorrow' }, ctx, 'aggregate');
    expect(outcome.status).toBe('partial');
    if (!('data' in outcome)) throw new Error('Missing aggregate evidence');
    expect(render(outcome.data, 'partial')).not.toContain('Daily');
  });

  it('uses civil date arithmetic across DST instead of adding 24 elapsed hours', async () => {
    const f = fixture();
    await f.tool.execute({ scope: 'tomorrow' }, { ...ctx, timezone: 'America/New_York', referenceTimeIso: '2026-03-09T03:30:00Z' }, 'aggregate');
    expect(f.calendarRead.mock.calls[0]?.[0]).toEqual({ operation: 'read', input: { scope: '2026-03-09' } });
  });

  it('cannot certify success with a missing or duplicated domain', () => {
    const f = { operation: 'read', date: '2026-10-15', complete: true, coverage: 'bounded_list', presentation,
      sections: [{ domain: 'calendar', status: 'success', code: null, result: calendar }] };
    expect(agendaResultSchema.safeParse(f).success).toBe(false);
    expect(agendaResultSchema.safeParse({ ...f, sections: [f.sections[0], f.sections[0], f.sections[0]] }).success).toBe(false);
  });
  it('reserves three journal operations before dispatching a combined read', async () => {
    const f = fixture();
    const response: AIResponse = { message: { role: 'assistant', content: '', toolCalls: [
      { id: 'agenda', name: 'agenda_read', arguments: { scope: 'tomorrow', turnDisposition: 'finish' } },
    ] }, stopReason: 'tool_calls', usage: { inputTokens: 900, outputTokens: 80 } };
    const provider = new MockAIProvider([{ response }], () => 100);
    const runner = new ProductivityTurnRunner(provider, f.registry, { ...productivityBudget, initialTools: ['agenda_read'],
      continuation: 'observation_driven', discoverTools: true, estimateInputTokens: estimateBoundedInput,
      now: () => 100, maxToolCalls: 2 });
    const journal = { beforeDispatch: vi.fn(async () => {}), afterOutcome: vi.fn(async () => {}) };
    const result = await runner.run('que tenemos para mañana', ctx, undefined, journal);
    expect(result.uiPayload.notices).toEqual(['limit_reached']);
    expect(f.calendarRead).not.toHaveBeenCalled(); expect(f.reminderRead).not.toHaveBeenCalled(); expect(f.taskRead).not.toHaveBeenCalled();
    expect(journal.afterOutcome).not.toHaveBeenCalled();
  });
});
