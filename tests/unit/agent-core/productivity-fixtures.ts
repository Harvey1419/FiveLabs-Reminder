import { vi } from 'vitest';
import { MockAIProvider } from '@templelabs/ai';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import { createTaskTools, createCalendarTools, createReminderTools, ToolRegistry } from '@templelabs/tools';
import { type AIResponse, type ToolCall, type TurnContext, type JsonObject } from '@templelabs/contracts';
import { createLegacyTaskPort } from '../../../src/adapters/agent-core/legacy-tasks.js';
import { createLegacyCalendarPort } from '../../../src/adapters/agent-core/legacy-calendar.js';
import { createLegacyReminderPort } from '../../../src/adapters/agent-core/legacy-reminders.js';
import { DurableProductivityAssistant, type ProductivityDeliveryPort } from '../../../src/adapters/agent-core/durable-productivity-assistant.js';
import { withTurnLease, type InboundTurnLease } from '../../../src/agent/core/turn-lease.js';

export const taskId = '11111111-1111-4111-8111-111111111111';
export const reminderId = '22222222-2222-4222-8222-222222222222';
export const context: TurnContext = { userId: 'owner', runId: 'run', requestId: 'request', language: 'es',
  timezone: 'America/Bogota', referenceTimeIso: '2026-10-11T17:49:00Z', signal: new AbortController().signal,
  capabilities: new Set(['tasks.read', 'tasks.create', 'tasks.complete', 'calendar.read', 'calendar.create', 'calendar.connect', 'reminders.create']) };
export const flow = { flowId: 'flow', buttonText: 'Ver tareas', flowToken: 'private-flow-token', flowAction: 'navigate' as const,
  screen: 'TASKS', mode: 'published' as const, data: { tasks: [{ id: taskId, title: 'Propuesta', description: 'Notas' }] } };
export const taskCreate: ToolCall = { id: 'task', name: 'task_create', arguments: { title: 'Propuesta', scheduleReminder: false } };
export const calendarRead: ToolCall = { id: 'calendar', name: 'calendar_read', arguments: { scope: 'today' } };
export const reminderCreate: ToolCall = { id: 'reminder', name: 'reminder_create', arguments: { content: 'Preparar reunión', targetTimeIso: '2026-10-11T21:00:00Z' } };
export function response(calls: ToolCall[] = []): AIResponse {
  return { message: { role: 'assistant', content: calls.length ? 'internal instructions' : '', toolCalls: calls }, stopReason: calls.length ? 'tool_calls' : 'completed',
    usage: { inputTokens: 30, outputTokens: 10 } };
}
export function setup(script: AIResponse[] = [response([calendarRead]), response([taskCreate]), response([reminderCreate]), response()]) {
  let persisted: JsonObject = {};
  let count = 0;
  let failAt = 0;
  const events: string[] = [];
  const execute = vi.fn(async (request: { toolName: string; params: JsonObject }) => {
    events.push('execute');
    if (request.toolName === 'manage_task') return { success: true,
      action: request.params.action === 'list' ? 'listed_tasks' : request.params.action === 'complete' ? 'completed_task' : 'created_tasks_batch',
      data: request.params.action === 'list' ? { tasks: [{ id: taskId, title: 'Propuesta' }] }
        : request.params.action === 'complete' ? { id: taskId, title: 'Propuesta', status: 'completed' } : [{ id: taskId, title: 'Propuesta', status: 'pending' }],
      flow };
    if (request.toolName === 'manage_google_calendar') return { success: true,
      action: request.params.action === 'get_connect_link' ? 'google_auth_link_generated' : 'google_events_listed',
      data: [{ id: 'event', summary: 'Reunión', type: 'all_day', localDate: '2026-10-11' }],
      ...(request.params.action === 'get_connect_link' ? { ctaUrl: 'https://example.test/oauth', ctaHeader: 'Calendar' } : {}) };
    return { success: true, action: 'created_reminders_batch', data: [{ id: reminderId, content: 'Preparar reunión', sendAt: '2026-10-11T21:00:00Z' }] };
  });
  const user = { id: context.userId, timezone: context.timezone };
  const provider = new MockAIProvider(script.map(response => ({ response })), () => 100);
  const runner = new ProductivityTurnRunner(provider, new ToolRegistry([...createTaskTools(createLegacyTaskPort(user, execute)),
    ...createCalendarTools(createLegacyCalendarPort(user, execute)), ...createReminderTools(createLegacyReminderPort(user, execute))]),
  { now: () => 100, continuation: 'observation_driven', authorizeWrite: async () => true });
  const send = vi.fn<ProductivityDeliveryPort['send']>(async message => { events.push('send'); return { messageId: `accepted-${message.id}` }; });
  const controller = new AbortController();
  const lease: InboundTurnLease = { inboundTurn: { id: 'run', messageId: 'request', threadId: 'thread', response: {} }, signal: controller.signal,
    assertActive: vi.fn(async () => {}), checkpoint: vi.fn(async patch => {
      count++; events.push(`checkpoint-${count}`);
      if (count === failAt) throw new Error('storage unavailable');
      persisted = { ...persisted, ...structuredClone(patch) };
    }) };
  const assistant = new DurableProductivityAssistant(runner, { send });
  return { assistant, runner, provider, execute, send, lease, controller, events, snapshot: () => structuredClone(persisted),
    fail: (at: number) => { failAt = at; }, run: () => withTurnLease(lease, () => assistant.handle('Agenda, tarea y recordatorio', context, 'thread')) };
}
