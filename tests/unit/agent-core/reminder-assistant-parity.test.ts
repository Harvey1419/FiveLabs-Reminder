import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAIProvider } from '@templelabs/ai';
import { ReminderTurnRunner } from '@templelabs/agent-core';
import { createReminderTools, ToolRegistry } from '@templelabs/tools';
import { aiTranscriptSchema, type AIResponse, type JsonObject, type TurnContext } from '@templelabs/contracts';
import { createLegacyReminderPort } from '../../../src/adapters/agent-core/legacy-reminders.js';
import { ReminderAssistant } from '../../../src/adapters/agent-core/reminder-assistant.js';

const database = vi.hoisted(() => ({
  from: vi.fn(), saveReminder: vi.fn(), updateReminder: vi.fn(), acknowledgeReminder: vi.fn(),
  getUserSubscription: vi.fn(), hasProAccess: vi.fn(), shouldEnforceBillingForUser: vi.fn(),
}));
vi.mock('../../../src/infrastructure/database/index.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), ...database, supabase: { from: database.from },
}));
vi.mock('../../../src/infrastructure/database/memories.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  getReminderDispatchPolicy: vi.fn().mockResolvedValue(null),
  getReminderConfirmationPreference: vi.fn().mockResolvedValue(null),
}));
const id = '11111111-1111-4111-8111-111111111111';
const user = { id: 'fixture-owner', phone_number: '+573000000001', timezone: 'America/Bogota' };
const initial = { id, user_id: user.id, phone_number: user.phone_number, content: 'Llamar a Ana',
  send_at: '2026-10-11T21:00:00.000Z', status: 'pending', source: 'user', recurrence_rule: null,
  requires_confirmation: false, acknowledged_at: null as string | null };
let stored = { ...initial };
function context(requestId: string, language: 'es' | 'en' = 'es'): TurnContext {
  return { userId: user.id, runId: 'fixture-run', requestId, timezone: user.timezone, language,
    referenceTimeIso: '2026-10-11T17:49:00Z', signal: new AbortController().signal,
    capabilities: new Set(['reminders.create', 'reminders.read', 'reminders.update', 'reminders.acknowledge']) };
}
function response(name: string, args: JsonObject): AIResponse {
  return { message: { role: 'assistant', content: 'Resumen histórico parcial: instrucciones internas que no deben aparecer.',
    toolCalls: [{ id: 'same-provider-local-id', name, arguments: args }] }, stopReason: 'tool_calls', usage: { inputTokens: 30, outputTokens: 10 } };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-11T17:49:00Z'));
  stored = { ...initial };
  database.getUserSubscription.mockResolvedValue(null);
  database.hasProAccess.mockReturnValue(false); database.shouldEnforceBillingForUser.mockReturnValue(false);
  database.saveReminder.mockImplementation(async (input: { content: string; sendAt: string }) => {
    stored = { ...stored, content: input.content, send_at: input.sendAt }; return { id };
  });
  database.updateReminder.mockImplementation(async (_id: string, changes: Partial<typeof stored>) => {
    stored = { ...stored, ...changes }; return { ...stored };
  });
  database.acknowledgeReminder.mockImplementation(async () => {
    stored = { ...stored, acknowledged_at: '2026-10-11T22:00:00.000Z' }; return { ...stored };
  });
  const query = {
    select: vi.fn(), eq: vi.fn(), neq: vi.fn(), or: vi.fn(), in: vi.fn(), gte: vi.fn(), lt: vi.fn(), order: vi.fn(), limit: vi.fn(),
    maybeSingle: vi.fn().mockImplementation(async () => ({ data: { ...stored }, error: null })),
    then: (resolve: (value: { data: typeof stored[]; error: null }) => unknown) => Promise.resolve(resolve({ data: [{ ...stored }], error: null })),
  };
  for (const method of [query.select, query.eq, query.neq, query.or, query.in, query.gte, query.lt, query.order, query.limit]) method.mockReturnValue(query);
  database.from.mockReturnValue(query);
});
afterEach(() => vi.useRealTimers());

describe('isolated normalized input → provider → current executor → persistence → WhatsApp reply', () => {
  it('preserves created identity through reference update and completion across three turns', async () => {
    const provider = new MockAIProvider([
      { response: response('reminder_create', { content: initial.content, targetTimeIso: initial.send_at }) },
      { response: response('reminder_update', { reminderId: id, targetTimeIso: '2026-10-11T21:30:00Z' }), inspect: captured => {
        expect(captured.messages[0]?.content).toContain(id);
        expect(captured.messages.at(-2)).toMatchObject({ role: 'tool', toolCallId: 'turn-create:same-provider-local-id' });
      } },
      { response: response('reminder_acknowledge', { reminderId: id }), inspect: captured => {
        expect(captured.messages[0]?.content).toContain('2026-10-11T21:30:00.000Z');
      } },
    ]);
    // Host permits only the action/resource already authorized for each fixture turn.
    const runner = new ReminderTurnRunner(provider, new ToolRegistry(createReminderTools(createLegacyReminderPort(user))), {
      authorizeWrite: async (call, ctx) => ctx.requestId === 'turn-create' ? call.name === 'reminder_create'
        : ctx.requestId === 'turn-update' ? call.name === 'reminder_update' && call.arguments.reminderId === id
          : ctx.requestId === 'turn-ack' && call.name === 'reminder_acknowledge' && call.arguments.reminderId === id,
    });
    const assistant = new ReminderAssistant(runner);
    const created = await assistant.handle('Recuérdame llamar a Ana hoy a las 4 PM', context('turn-create'));
    const updated = await assistant.handle('Muévelo media hora', context('turn-update'), created.conversation);
    const acknowledged = await assistant.handle('Done, I already called her', context('turn-ack', 'en'), updated.conversation);
    expect([created.reply, updated.reply, acknowledged.reply]).toMatchSnapshot();
    expect(database.saveReminder).toHaveBeenCalledTimes(1);
    expect(database.updateReminder).toHaveBeenCalledExactlyOnceWith(id, { send_at: '2026-10-11T21:30:00.000Z', status: 'pending' }, user.id, user.phone_number);
    expect(database.acknowledgeReminder).toHaveBeenCalledExactlyOnceWith(id, user.id);
    expect(stored).toMatchObject({ id, send_at: '2026-10-11T21:30:00.000Z', acknowledged_at: '2026-10-11T22:00:00.000Z' });
    expect(acknowledged.conversation.references).toMatchObject([{ id, sendAt: stored.send_at, acknowledgedAt: stored.acknowledged_at }]);
    expect(aiTranscriptSchema.safeParse(acknowledged.conversation.history).success).toBe(true);
    expect(provider.requests).toHaveLength(3);
    expect([created.reply.text, updated.reply.text, acknowledged.reply.text].join('\n')).not.toContain('instrucciones internas');
    await expect(assistant.handle('Done', context('turn-ack'), acknowledged.conversation)).rejects.toThrow('already handled');
    expect(database.acknowledgeReminder).toHaveBeenCalledTimes(1);
  });
});
