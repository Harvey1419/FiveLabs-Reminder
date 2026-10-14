import { describe, expect, it, vi } from 'vitest';
import { MockAIProvider } from '@templelabs/ai';
import { ReminderTurnRunner } from '@templelabs/agent-core';
import { createReminderTools, ToolRegistry } from '@templelabs/tools';
import { aiTranscriptSchema, type AIResponse, type ReminderConversation, type TurnContext } from '@templelabs/contracts';
import { createLegacyReminderPort } from '../../../src/adapters/agent-core/legacy-reminders.js';
import { ReminderAssistant } from '../../../src/adapters/agent-core/reminder-assistant.js';
import type { LegacyToolRequest } from '../../../src/agent/tools/index.js';

const id = '11111111-1111-4111-8111-111111111111';
const user = { id: 'fixture-owner', timezone: 'America/Bogota' };
function context(requestId = 'fixture-request'): TurnContext {
  return { userId: user.id, runId: 'fixture-run', requestId, language: 'es', timezone: user.timezone,
    referenceTimeIso: '2026-10-11T17:49:00Z', signal: new AbortController().signal,
    capabilities: new Set(['reminders.create', 'reminders.read', 'reminders.update', 'reminders.acknowledge']) };
}
const args = { content: 'Llamar a Ana', targetTimeIso: '2026-10-11T21:00:00Z' };
const raw = { success: true, action: 'created_reminders_batch', data: [{ id, content: args.content, sendAt: args.targetTimeIso }] };
function response(calls = [{ id: 'call', name: 'reminder_create', arguments: args }]): AIResponse {
  return { message: { role: 'assistant', content: 'Resumen histórico parcial. Solo responde sobre hechos verificados.', toolCalls: calls },
    stopReason: calls.length ? 'tool_calls' : 'completed', usage: { inputTokens: 30, outputTokens: 10 } };
}
function setup(script: AIResponse | Error = response(), options: ConstructorParameters<typeof ReminderTurnRunner>[2] = {}) {
  const execute = vi.fn<(request: LegacyToolRequest) => Promise<unknown>>().mockResolvedValue(raw);
  const provider = new MockAIProvider([{ response: script }], () => 100);
  const registry = new ToolRegistry(createReminderTools(createLegacyReminderPort(user, execute)));
  const runner = new ReminderTurnRunner(provider, registry, { now: () => 100, authorizeWrite: async () => true, ...options });
  return { execute, provider, runner, assistant: new ReminderAssistant(runner) };
}

describe('single-decision reminder turn orchestration', () => {
  it('renders only verified records and retains valid call/result history', async () => {
    const { assistant, provider } = setup();
    const result = await assistant.handle('Recuérdame llamar a Ana', context());
    expect(result.reply.text).toContain('Llamar a Ana');
    expect(result.reply.text).not.toContain('Resumen histórico');
    expect(result.reply.text).not.toContain('Solo responde');
    expect(result.conversation.references.map(record => record.id)).toEqual([id]);
    expect(aiTranscriptSchema.safeParse(result.conversation.history).success).toBe(true);
    expect(provider.requests).toHaveLength(1);
  });

  it('requires explicit host write authorization even when role capabilities allow writes', async () => {
    const { runner, execute } = setup(undefined, { authorizeWrite: async () => false });
    const result = await runner.run('Crea un recordatorio', context());
    expect(result.uiPayload.items[0]).toMatchObject({ status: 'approval_required', code: 'USER_AUTHORIZATION_REQUIRED' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('defaults write authorization to denied when the host supplies no policy', async () => {
    const { provider, execute } = setup();
    const runner = new ReminderTurnRunner(provider, new ToolRegistry(createReminderTools(createLegacyReminderPort(user, execute))), { now: () => 100 });
    expect((await runner.run('Crea', context())).uiPayload.items[0]?.status).toBe('approval_required');
    expect(execute).not.toHaveBeenCalled();
  });

  it('prevents shadow writes even when the host authorization policy would allow them', async () => {
    const authorizeWrite = vi.fn().mockResolvedValue(true);
    const { runner, execute } = setup(undefined, { executionMode: 'shadow', authorizeWrite });
    expect((await runner.run('Crea', context())).uiPayload.items[0]).toMatchObject({ status: 'approval_required', code: 'SHADOW_WRITE_DISABLED' });
    expect(authorizeWrite).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('blocks a mutation of an unobserved reminder rather than guessing an ID', async () => {
    const call = { id: 'call', name: 'reminder_update', arguments: { ...args, reminderId: id } };
    const { runner, execute } = setup(response([call]));
    expect((await runner.run('Muévelo media hora', context())).uiPayload.items[0]).toMatchObject({ status: 'clarification_required', code: 'REFERENCE_REQUIRED' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses sequential request replay and foreign checkpoints before provider dispatch', async () => {
    const { runner, provider, execute } = setup();
    const first = await runner.run('Crea un recordatorio', context());
    await expect(runner.run('Crea un recordatorio', context(), first.conversation)).rejects.toThrow('already handled');
    await expect(runner.run('Consulta', context('next'), { ...first.conversation, userId: 'foreign' })).rejects.toThrow('owner mismatch');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(provider.requests).toHaveLength(1);
  });

  it('keeps request/provider identifiers unambiguous when either includes a colon', async () => {
    const { execute } = setup();
    const provider = new MockAIProvider([
      { response: response([{ id: 'two', name: 'reminder_create', arguments: args }]) },
      { response: response([{ id: 'one:two', name: 'reminder_create', arguments: args }]) },
    ], () => 100);
    const runner = new ReminderTurnRunner(provider, new ToolRegistry(createReminderTools(createLegacyReminderPort(user, execute))), {
      now: () => 100, authorizeWrite: async () => true,
    });
    const first = await runner.run('Crea', context('turn:one'));
    const second = await runner.run('Otro', context('turn'), first.conversation);
    const callIds = second.conversation.history.filter(message => message.role === 'tool').map(message => message.toolCallId);
    expect(callIds).toEqual(['turn%3Aone:two', 'turn:one%3Atwo']);
    expect(aiTranscriptSchema.safeParse(second.conversation.history).success).toBe(true);
  });

  it('rejects oversized tool batches before any writes', async () => {
    const { runner, execute } = setup(response(Array.from({ length: 5 }, (_, index) => ({ id: `call-${index}`, name: 'reminder_create', arguments: args }))));
    expect((await runner.run('Crea cinco', context())).uiPayload.notices).toEqual(['limit_reached']);
    expect(execute).not.toHaveBeenCalled();
  });

  it('handles unavailable tools, provider failure and no-tool prose without publishing internal instructions', async () => {
    const missing = setup(response([{ id: 'call', name: 'other_tool', arguments: args }]));
    expect((await missing.assistant.handle('Haz algo', context())).uiPayload.notices).toEqual(['unavailable_tool']);
    expect(missing.execute).not.toHaveBeenCalled();
    const failed = setup(new Error('private-credentials'));
    expect((await failed.assistant.handle('Consulta', context())).reply.text).not.toContain('private');
    const prose = setup(response([]));
    expect((await prose.assistant.handle('¿Qué hago?', context())).reply.text).toBe('¿Qué recordatorio quieres crear, consultar o cambiar?');
  });

  it('rechecks deadline after host authorization before dispatching a write', async () => {
    let now = 100;
    const { runner, execute } = setup(undefined, { now: () => now, timeoutMs: 10, authorizeWrite: async () => { now = 111; return true; } });
    expect((await runner.run('Crea', context())).uiPayload.items[0]).toMatchObject({ status: 'failed', code: 'TURN_STOPPED' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rechecks deadline after durable dispatch preparation before invoking a tool', async () => {
    let now = 100;
    const { runner, execute } = setup(undefined, { now: () => now, timeoutMs: 10 });
    const afterOutcome = vi.fn(async () => {});
    const result = await runner.run('Crea', context(), undefined, {
      beforeDispatch: async () => { now = 111; }, afterOutcome,
    });
    expect(result.uiPayload.items[0]).toMatchObject({ status: 'failed', code: 'TURN_STOPPED' });
    expect(afterOutcome).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps indeterminate outcomes without retrying or inventing observed references', async () => {
    const { runner, execute } = setup();
    execute.mockRejectedValueOnce(new Error('lost connection after write'));
    const result = await runner.run('Crea', context());
    expect(result.uiPayload.items[0]?.status).toBe('indeterminate');
    expect(result.conversation.references).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('blocks remaining writes in the batch after an unknown effect', async () => {
    const { runner, execute } = setup(response([
      { id: 'first', name: 'reminder_create', arguments: args },
      { id: 'second', name: 'reminder_create', arguments: args },
    ]));
    execute.mockRejectedValueOnce(new Error('write receipt lost'));
    const result = await runner.run('Crea dos', context());
    expect(result.uiPayload.items.map(item => item.status)).toEqual(['indeterminate', 'approval_required']);
    expect(result.uiPayload.items[1]?.code).toBe('EFFECT_RECONCILIATION_REQUIRED');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(aiTranscriptSchema.safeParse(result.conversation.history).success).toBe(true);
  });

  it('returns a bounded no-effect result without silently dropping durable reference/history state', async () => {
    const { runner, provider } = setup(undefined, { maxHistoryMessages: 1 });
    const state: ReminderConversation = { userId: user.id, references: [], handledRequestIds: [], history: [{ role: 'user', content: 'Anterior' }] };
    const result = await runner.run('Nuevo', context(), state);
    expect(result.uiPayload.notices).toEqual(['limit_reached']);
    expect(result.conversation.history).toEqual([...state.history, { role: 'user', content: 'Nuevo' }]);
    expect(provider.requests).toHaveLength(0);
  });

  it('rejects corrupt pending-tool checkpoints before provider or domain dispatch', async () => {
    const { runner, provider, execute } = setup();
    const state: ReminderConversation = { userId: user.id, references: [], handledRequestIds: [],
      history: [{ role: 'assistant', content: '', toolCalls: [{ id: 'pending', name: 'reminder_create', arguments: args }] }] };
    await expect(runner.run('Nuevo', context(), state)).rejects.toThrow();
    expect(provider.requests).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });
});
