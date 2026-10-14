import { describe, expect, it, vi } from 'vitest';
import { MockAIProvider } from '@templelabs/ai';
import { ProductivityTurnRunner, prepareProductivityContext, summarizeProductivityOperations,
  type ProductivityExecutionJournal } from '@templelabs/agent-core';
import { createTaskTools, createCalendarTools, createReminderTools, ToolRegistry } from '@templelabs/tools';
import { aiTranscriptSchema, productivityItemSchema, type AIMessage, type AIResponse, type ToolCall, type TurnContext } from '@templelabs/contracts';
import { createLegacyTaskPort } from '../../../src/adapters/agent-core/legacy-tasks.js';
import { createLegacyCalendarPort } from '../../../src/adapters/agent-core/legacy-calendar.js';
import { createLegacyReminderPort } from '../../../src/adapters/agent-core/legacy-reminders.js';
import type { AgentLoopOptions } from '@templelabs/agent-core';

const id = '11111111-1111-4111-8111-111111111111';
const reminderId = '22222222-2222-4222-8222-222222222222';
const task = { id, title: 'Propuesta', status: 'pending', priority: 'high', description: 'Private notes' };
const event = { id: 'event', summary: 'Reunión', start: '2026-10-11T21:00:00Z', end: '2026-10-11T22:00:00Z', isAllDay: false };
const user = { id: 'owner', timezone: 'America/Bogota' };
const context: TurnContext = { userId: user.id, runId: 'run', requestId: 'request', language: 'es', timezone: user.timezone,
  referenceTimeIso: '2026-10-11T17:49:00Z', signal: new AbortController().signal,
  capabilities: new Set(['tasks.read', 'tasks.create', 'tasks.update', 'tasks.complete', 'tasks.delete',
    'calendar.read', 'calendar.create', 'calendar.connect', 'reminders.read', 'reminders.create']) };
function response(calls: ToolCall[] = []): AIResponse {
  return { message: { role: 'assistant', content: 'Never publish internal reasoning.', toolCalls: calls },
    stopReason: calls.length ? 'tool_calls' : 'completed', usage: { inputTokens: 30, outputTokens: 10 } };
}
const taskRead: ToolCall = { id: 'local', name: 'task_read', arguments: {} };
const taskCreate: ToolCall = { id: 'local', name: 'task_create', arguments: { title: task.title, scheduleReminder: false } };
const calendarRead: ToolCall = { id: 'local', name: 'calendar_read', arguments: { scope: 'today' } };
const calendarCreate: ToolCall = { id: 'local', name: 'calendar_create', arguments: { kind: 'timed', summary: event.summary,
  startIso: event.start, endIso: event.end } };
function setup(script: AIResponse[], options: AgentLoopOptions = {}) {
  const execute = vi.fn().mockImplementation(async request => {
    const action = request.params.action;
    if (request.toolName === 'manage_task') {
      if (action === 'list') return { success: true, action: 'listed_tasks', data: { tasks: [task] } };
      if (action === 'create') return { success: true, action: 'created_tasks_batch', data: [task] };
      return { success: true, action: `${action === 'complete' ? 'completed' : action === 'delete' ? 'deleted' : 'updated'}_task`, data: task };
    }
    if (request.toolName === 'manage_google_calendar') return { success: true,
      action: action === 'list_events' ? 'google_events_listed' : action === 'get_connect_link' ? 'google_auth_link_generated' : 'google_event_created',
      data: action === 'list_events' ? [event] : event,
      ...(action === 'get_connect_link' ? { ctaUrl: 'https://example.test/oauth' } : {}) };
    return { success: true, action: 'created_reminders_batch', data: [{ id: reminderId, content: 'Preparar reunión', sendAt: event.start }] };
  });
  const provider = new MockAIProvider(script.map(response => ({ response })), () => 100);
  const registry = new ToolRegistry([...createTaskTools(createLegacyTaskPort(user, execute)),
    ...createCalendarTools(createLegacyCalendarPort(user, execute)), ...createReminderTools(createLegacyReminderPort(user, execute))]);
  const prepared: string[] = [];
  const observations: string[] = [];
  const journal: ProductivityExecutionJournal = {
    beforeDispatch: vi.fn(async call => { prepared.push(call.id); }),
    afterOutcome: vi.fn(async (call, item) => { productivityItemSchema.parse(item); observations.push(call.id); }),
  };
  const runner = new ProductivityTurnRunner(provider, registry, { now: () => 100,
    continuation: 'observation_driven', authorizeWrite: async () => true, ...options });
  return { runner, execute, provider, journal, prepared, observations };
}

describe('shared productivity observation loop', () => {
  it.each([
    ['es', 'America/Bogota', 'miércoles, 14 de octubre de 2026, 11:05 a. m.'],
    ['en', 'America/Bogota', 'Wednesday, October 14, 2026 at 11:05 AM'],
    ['en', 'Asia/Tokyo', 'Thursday, October 15, 2026 at 1:05 AM'],
  ] as const)('injects local reference time for %s in %s', async (language, timezone, expected) => {
    const s = setup([response()]);
    await s.runner.run('Hola', { ...context, language, timezone, referenceTimeIso: '2026-10-14T16:05:00Z' });
    const system = s.provider.requests[0]?.messages.find(message => message.role === 'system');
    expect(system?.content).toContain(JSON.stringify({ userLocalTime: expected }).slice(1, -1));
    expect(system?.content).toContain(`local timezone (${timezone})`);
    expect(system?.content).toContain('Never expose, calculate, or cite raw UTC timestamps');
    expect(system?.content).toContain('Certified cards render formatted local times');
  });
  it('caps committed writes while allowing schema-error self-correction before the first mutation', async () => {
    const s = setup([
      response([{ ...taskCreate, arguments: { title: '' } }]),
      response([taskCreate]),
      response([{ ...taskCreate, arguments: { title: 'Unexpected extra task', scheduleReminder: false } }]),
      response(),
    ], { maxWriteOperations: 1 });
    const result = await s.runner.run('Crea una tarea', context, undefined, s.journal);
    expect(s.execute).toHaveBeenCalledOnce();
    expect(result.uiPayload.items.map(item => item.status)).toEqual(['validation_failed', 'success', 'approval_required']);
    expect(result.uiPayload.items.at(-1)?.code).toBe('WRITE_OPERATION_LIMIT');
    expect(result.requiresReconciliation).toBe(false);
  });

  it('reads a task, updates its observed ID and persists each observation before continuing', async () => {
    const update: ToolCall = { id: 'local', name: 'task_update', arguments: { taskId: id, priority: 'urgent' } };
    const s = setup([response([taskRead]), response([update]), response()]);
    const result = await s.runner.run('Busca la propuesta y sube su prioridad', context, undefined, s.journal);
    expect(result.uiPayload.items.map(item => [item.domain, item.status])).toEqual([['tasks', 'success'], ['tasks', 'success']]);
    expect(s.prepared).toEqual(['request:local', 'request:step:1:local']);
    expect(s.observations).toEqual(s.prepared);
    expect(s.execute.mock.calls[1]?.[0].params).toMatchObject({ action: 'update', target: id, updates: { priority: 'urgent' } });
    expect(JSON.stringify(s.provider.requests[1]?.messages)).toContain(id);
    expect(JSON.stringify(s.provider.requests[1]?.messages[0])).not.toContain('Private notes');
    expect(result.requiresReconciliation).toBe(false);
    expect(result.usage.modelSteps).toBe(3);
    expect(aiTranscriptSchema.safeParse(result.conversation.history).success).toBe(true);
  });

  it('observes calendar events and then creates distinct task and reminder effects in one turn', async () => {
    const reminder: ToolCall = { id: 'local', name: 'reminder_create', arguments: { content: 'Preparar reunión', targetTimeIso: event.start } };
    const s = setup([response([calendarRead]), response([taskCreate]), response([reminder]), response()]);
    const result = await s.runner.run('Revisa mi agenda y crea la tarea y el recordatorio', context, undefined, s.journal);
    expect(result.uiPayload.items.map(item => item.domain)).toEqual(['calendar', 'tasks', 'reminders']);
    expect(result.conversation.events[0]?.id).toBe(event.id);
    expect(result.conversation.tasks[0]?.id).toBe(id);
    expect(result.conversation.reminders[0]?.id).toBe(reminderId);
    expect(s.execute).toHaveBeenCalledTimes(3);
    for (const request of s.provider.requests) expect(aiTranscriptSchema.safeParse(request.messages).success).toBe(true);
  });

  it('corrects invalid calendar intervals before invoking the executor', async () => {
    const s = setup([response([{ ...calendarCreate, arguments: { ...calendarCreate.arguments, endIso: '2026-10-11T20:00:00Z' } }]),
      response([calendarCreate]), response()]);
    const result = await s.runner.run('Agenda reunión', context, undefined, s.journal);
    expect(result.uiPayload.items.map(item => item.status)).toEqual(['validation_failed', 'success']);
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(s.provider.requests[1]?.messages)).toContain('Invalid arguments');
  });

  it.each(['task_update', 'task_complete', 'task_delete'])('blocks guessed task IDs for %s', async name => {
    const s = setup([response([{ id: 'call', name, arguments: { taskId: id, ...(name === 'task_update' ? { priority: 'urgent' } : {}) } }]), response()]);
    const result = await s.runner.run('Cambia esa tarea', context, undefined, s.journal);
    expect(result.uiPayload.items[0]).toMatchObject({ status: 'clarification_required', code: 'REFERENCE_REQUIRED' });
    expect(s.execute).not.toHaveBeenCalled();
  });

  it('requires a journal for writes even when the host permits them, while allowing journal-free reads', async () => {
    const s = setup([response([taskCreate]), response()]);
    expect((await s.runner.run('Crea', context)).uiPayload.items[0]).toMatchObject({ status: 'failed', code: 'DURABLE_JOURNAL_REQUIRED' });
    expect(s.execute).not.toHaveBeenCalled();
    const read = setup([response([calendarRead]), response()]);
    expect((await read.runner.run('Consulta', context)).uiPayload.items[0]?.status).toBe('success');
  });

  it('requires user authorization for completing/deleting an observed task', async () => {
    const s = setup([response([taskRead]), response([{ id: 'delete', name: 'task_delete', arguments: { taskId: id } }]), response()],
      { authorizeWrite: async () => false });
    const result = await s.runner.run('Consulta y elimina', context, undefined, s.journal);
    expect(result.uiPayload.items[1]).toMatchObject({ status: 'approval_required', code: 'USER_AUTHORIZATION_REQUIRED' });
    expect(s.execute).toHaveBeenCalledTimes(1);
  });

  it('never dispatches an unadvertised capability and preserves paired denial', async () => {
    const s = setup([response([taskCreate]), response()]);
    const result = await s.runner.run('Crea', { ...context, capabilities: new Set(['tasks.read']) }, undefined, s.journal);
    expect(result.uiPayload.notices).toEqual(['unavailable_tool']);
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.prepared).toEqual([]);
    expect(aiTranscriptSchema.safeParse(result.conversation.history).success).toBe(true);
  });

  it('stops all remaining writes and continuation when a calendar effect is unknown', async () => {
    const s = setup([response([calendarCreate, { ...taskCreate, id: 'task' }]), response()]);
    s.execute.mockRejectedValueOnce(new Error('receipt lost'));
    const result = await s.runner.run('Agenda y crea tarea', context, undefined, s.journal);
    expect(result.uiPayload.items.map(item => item.status)).toEqual(['indeterminate', 'approval_required']);
    expect(result.requiresReconciliation).toBe(true);
    expect(s.provider.requests).toHaveLength(1);
    expect(s.execute).toHaveBeenCalledTimes(1);
  });

  it.each(['tasks', 'calendar'])('retains principal %s success and fences unverified companion effects', async domain => {
    const call = domain === 'tasks' ? { ...taskCreate, arguments: { title: task.title, dueDateIso: event.start } }
      : { ...calendarCreate, arguments: { ...calendarCreate.arguments, advanceMinutes: 15 } };
    const s = setup([response([call, { ...taskCreate, id: 'later', arguments: { title: 'Otra tarea' } }]), response()]);
    const result = await s.runner.run('Crea con recordatorio asociado', context, undefined, s.journal);
    expect(result.uiPayload.items.map(item => item.status)).toEqual(['partial', 'approval_required']);
    expect(result.requiresReconciliation).toBe(true);
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.provider.requests).toHaveLength(1);
    await expect(s.runner.run('Crea otra', { ...context, requestId: 'next' }, result.conversation, s.journal))
      .rejects.toMatchObject({ code: 'EFFECT_RECONCILIATION_REQUIRED' });
    expect(s.provider.requests).toHaveLength(1);
  });

  it('never repeats successful principal writes with a fresh local call ID', async () => {
    const s = setup([response([calendarCreate]), response([{ ...calendarCreate, id: 'retry' }]), response()]);
    expect((await s.runner.run('Agenda', context, undefined, s.journal)).uiPayload.items[1]).toMatchObject({ code: 'DUPLICATE_WRITE' });
    expect(s.execute).toHaveBeenCalledTimes(1);
  });

  it.each(['before', 'after'])('propagates %s journal failure and never continues or retries', async when => {
    const s = setup([response([taskCreate]), response()]);
    const journal = { ...s.journal, [when === 'before' ? 'beforeDispatch' : 'afterOutcome']: async () => { throw new Error('storage unavailable'); } };
    await expect(s.runner.run('Crea', context, undefined, journal)).rejects.toThrow('storage unavailable');
    expect(s.execute).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
    expect(s.provider.requests).toHaveLength(1);
  });

  it('guards replay, ownership and prior unknown histories before provider admission', async () => {
    const s = setup([response([taskCreate]), response()]);
    const result = await s.runner.run('Crea', context, undefined, s.journal);
    await expect(s.runner.run('Otra', context, result.conversation, s.journal)).rejects.toThrow('already handled');
    await expect(s.runner.run('Otra', { ...context, requestId: 'next' }, { ...result.conversation, userId: 'foreign' }, s.journal)).rejects.toThrow('owner mismatch');
    const history: AIMessage[] = [{ role: 'assistant', content: '', toolCalls: [{ ...taskCreate, id: 'old' }] },
      { role: 'tool', toolCallId: 'old', content: { status: 'indeterminate' }, isError: true }];
    await expect(s.runner.run('Otra', { ...context, requestId: 'next' }, { ...result.conversation, history }, s.journal))
      .rejects.toMatchObject({ code: 'EFFECT_RECONCILIATION_REQUIRED' });
    expect(s.execute).toHaveBeenCalledTimes(1);
  });

  it('bounds repeated unavailable-tool notices before reporting a later call limit', async () => {
    const unavailable = Array.from({ length: 10 }, (_, index) => ({ id: `unsupported-${index}`, name: 'unsupported', arguments: {} }));
    const s = setup([response(unavailable), response([taskCreate])], { maxToolCalls: 10 });
    const result = await s.runner.run('Haz algo', context, undefined, s.journal);
    expect(result.uiPayload.notices).toEqual(['unavailable_tool', 'limit_reached']);
    expect(result.uiPayload.items).toEqual([]);
    expect(s.execute).not.toHaveBeenCalled();
    expect(aiTranscriptSchema.safeParse(result.conversation.history).success).toBe(true);
  });

  it('keeps calendar authorization links in typed facts without claiming connection', async () => {
    const s = setup([response([{ id: 'connect', name: 'calendar_connect', arguments: {} }]), response()]);
    const result = await s.runner.run('Conecta Google', context);
    expect(result.uiPayload.items[0]).toMatchObject({ domain: 'calendar', status: 'success',
      result: { connection: 'authorization_required', presentation: { cta: { url: 'https://example.test/oauth' } } } });
    expect(result.conversation.events).toEqual([]);
  });

  it('blocks mutation of a task that this run has already deleted', async () => {
    const s = setup([response([taskRead]), response([{ id: 'delete', name: 'task_delete', arguments: { taskId: id } }]),
      response([{ id: 'update', name: 'task_update', arguments: { taskId: id, priority: 'urgent' } }]), response()]);
    const result = await s.runner.run('Elimina y cambia', context, undefined, s.journal);
    expect(result.uiPayload.items[2]).toMatchObject({ status: 'clarification_required', code: 'REFERENCE_REQUIRED' });
    expect(result.conversation.tasks[0]?.status).toBe('deleted');
    expect(s.execute).toHaveBeenCalledTimes(2);
  });

  it('preserves all-day calendar dates through the multihop loop', async () => {
    const s = setup([response([{ id: 'holiday', name: 'calendar_create', arguments: { kind: 'all_day',
      summary: 'Feriado', startDate: '2026-10-11', endDateExclusive: '2026-10-12' } }]), response()]);
    s.execute.mockResolvedValueOnce({ success: true, action: 'google_event_created', data: { id: 'holiday',
      summary: 'Feriado', start: '2026-10-11', end: '2026-10-12', isAllDay: true } });
    const result = await s.runner.run('Agenda feriado', context, undefined, s.journal);
    expect(result.conversation.events[0]).toMatchObject({ kind: 'all_day', startDate: '2026-10-11', endDateExclusive: '2026-10-12' });
    expect(s.execute.mock.calls[0]?.[0].params).toMatchObject({ allDay: true, startDate: '2026-10-11', endDate: '2026-10-12' });
  });

  it('uses the same cumulative call/token/spend limits across domains', async () => {
    const calls = setup([response([calendarRead]), response([taskCreate])], { maxToolCalls: 1 });
    expect((await calls.runner.run('Consulta y crea', context, undefined, calls.journal)).uiPayload.notices).toEqual(['limit_reached']);
    expect(calls.execute).toHaveBeenCalledTimes(1);
    const tokens = setup([response([taskCreate])], { maxInputTokens: 20, estimateInputTokens: () => 21 });
    expect((await tokens.runner.run('Crea', context, undefined, tokens.journal)).uiPayload.notices).toEqual(['limit_reached']);
    expect(tokens.provider.requests).toHaveLength(0);
    const cost = setup([response([taskCreate])], { maxCostUsd: 0.000001,
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, estimateInputTokens: () => 5 });
    expect((await cost.runner.run('Crea', context, undefined, cost.journal)).uiPayload.notices).toEqual(['limit_reached']);
    expect(cost.provider.requests).toHaveLength(0);
  });

  it('retains task/calendar pending provenance when compacting away the original batches', () => {
    const history: AIMessage[] = Array.from({ length: 5 }, (_, index) => [
      { role: 'user' as const, content: 'Earlier conversation' },
      { role: 'assistant' as const, content: '', toolCalls: [{ ...taskCreate, id: `old-${index}` }] },
      { role: 'tool' as const, toolCallId: `old-${index}`, content: { status: index === 0 ? 'partial' : 'failed' }, isError: index !== 0 },
    ]).flat();
    const summary = summarizeProductivityOperations(history, 6, context.userId);
    expect(summary.pending[0]).toMatchObject({ callId: 'old-0', toolName: 'task_create', status: 'partial' });
    const prepared = prepareProductivityContext(history, context.userId, 'Persona', 9, () => true);
    expect(JSON.stringify(prepared.messages[0])).toContain('old-0');
    expect(aiTranscriptSchema.safeParse(prepared.messages).success).toBe(true);
    expect(productivityItemSchema.safeParse({ domain: 'tasks', callId: 'x', toolName: 'calendar_create',
      status: 'success', code: null, result: null }).success).toBe(false);
  });
});
