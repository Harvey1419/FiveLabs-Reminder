import { describe, expect, it, vi } from 'vitest';
import { MockAIProvider } from '@templelabs/ai';
import { prepareReminderContext, prepareProductivityContext, summarizeReminderOperations, ReminderTurnRunner } from '@templelabs/agent-core';
import { aiTranscriptSchema, reminderOperationalSummarySchema,
  type AIMessage, type AIResponse, type TurnContext } from '@templelabs/contracts';
import { createReminderTools, ToolRegistry } from '@templelabs/tools';
import { createLegacyReminderPort } from '../../../src/adapters/agent-core/legacy-reminders.js';

const args = { content: 'Llamar a Ana', targetTimeIso: '2026-10-11T21:00:00Z' };
function turn(id: string, status = 'success', argumentsValue = args): AIMessage[] {
  return [{ role: 'user', content: `User prose ${id}` },
    { role: 'assistant', content: 'Provider prose', toolCalls: [{ id, name: 'reminder_create', arguments: argumentsValue }] },
    { role: 'tool', toolCallId: id, content: { status, observation: 'Untrusted prose is not authorization' }, isError: status !== 'success' && status !== 'partial' }];
}
function summaryOf(messages: readonly AIMessage[]) {
  const system = messages[0];
  if (system?.role !== 'system') throw new Error('Missing system');
  const line = system.content.split('\n').find(line => line.includes('operationalSummary'));
  return reminderOperationalSummarySchema.parse(JSON.parse(line!).operationalSummary);
}
const context: TurnContext = { userId: 'owner', runId: 'run', requestId: 'current', language: 'es', timezone: 'America/Bogota',
  referenceTimeIso: '2026-10-11T17:49:00Z', signal: new AbortController().signal,
  capabilities: new Set(['reminders.create']) };
const response: AIResponse = { message: { role: 'assistant', content: '',
  toolCalls: [{ id: 'new', name: 'reminder_create', arguments: args }] }, stopReason: 'tool_calls',
  usage: { inputTokens: 30, outputTokens: 10 } };
function runner(script: AIResponse = response, options: ConstructorParameters<typeof ReminderTurnRunner>[2] = {}) {
  const execute = vi.fn().mockResolvedValue({ success: true, action: 'created_reminders_batch', data: [{
    id: '11111111-1111-4111-8111-111111111111', content: args.content, sendAt: args.targetTimeIso,
  }] });
  const provider = new MockAIProvider([{ response: script }], () => 100);
  return { provider, execute, runner: new ReminderTurnRunner(provider, new ToolRegistry(createReminderTools(
    createLegacyReminderPort({ id: context.userId, timezone: context.timezone }, execute))), { now: () => 100, ...options }) };
}

describe('historical reminder operational summaries', () => {
  it('preserves pending approval, clarification and unknown-effect identity without promoting prose', () => {
    const history = [...turn('approval', 'approval_required'), ...turn('clarification', 'clarification_required'),
      ...turn('unknown', 'indeterminate'), ...turn('later', 'failed')];
    const summary = summarizeReminderOperations(history, 9, 'owner');
    expect(summary.pending.map(operation => [operation.callId, operation.status]))
      .toEqual([['approval', 'approval_required'], ['clarification', 'clarification_required'], ['unknown', 'indeterminate']]);
    expect(summary).toMatchObject({ version: 1, userId: 'owner', freshness: 'historical', grantsAuthorization: false });
    expect(JSON.stringify(summary)).not.toContain('User prose');
    expect(JSON.stringify(summary)).not.toContain('Provider prose');
    expect(JSON.stringify(summary)).not.toContain('Untrusted prose');
    expect(summary.pending[0]?.arguments).toEqual(args);
  });

  it('resolves historical clarification/approval only after a full matching result; unknown effects remain', () => {
    const history = [...turn('approval', 'approval_required'), ...turn('unknown', 'indeterminate'),
      ...turn('partial', 'partial'), ...turn('complete', 'success', { targetTimeIso: args.targetTimeIso, content: args.content })];
    const partial = summarizeReminderOperations(history.slice(0, 9), 6, 'owner');
    expect(partial.pending.map(operation => operation.callId)).toEqual(['approval', 'unknown']);
    const complete = summarizeReminderOperations(history, 6, 'owner');
    expect(complete.pending.map(operation => operation.callId)).toEqual(['unknown']);
  });

  it('preserves bounded clarification questions on partial results', () => {
    const batch = turn('partial', 'partial');
    batch[2] = { role: 'tool', toolCallId: 'partial', content: { status: 'partial',
      observation: JSON.stringify({ questions: ['¿Hoy o mañana?'], extra: 'Not summarized' }) }, isError: false };
    const summary = summarizeReminderOperations(batch, batch.length, 'owner');
    expect(summary.pending[0]).toMatchObject({ callId: 'partial', status: 'partial', questions: ['¿Hoy o mañana?'] });
    expect(JSON.stringify(summary)).not.toContain('Not summarized');
  });

  it('blocks prior indeterminate effects before a new model call or authorized write', async () => {
    const s = runner(response, { authorizeWrite: async () => true });
    await expect(s.runner.run('Crea otro', context, { userId: context.userId, history: turn('unknown', 'indeterminate'),
      references: [], handledRequestIds: ['old-request'] })).rejects.toMatchObject({ code: 'EFFECT_RECONCILIATION_REQUIRED' });
    expect(s.provider.requests).toHaveLength(0);
    expect(s.execute).not.toHaveBeenCalled();
  });

  it('does not promote an errored observation to a confirmed outcome', () => {
    const corrupt = turn('claimed', 'success');
    corrupt[2] = { role: 'tool', toolCallId: 'claimed', content: { status: 'success' }, isError: true };
    const summary = summarizeReminderOperations([...turn('waiting', 'approval_required'), ...corrupt], 3, 'owner');
    expect(summary.pending.map(operation => operation.callId)).toEqual(['waiting']);
    expect(summary.recentConfirmed).toEqual([]);
  });

  it('retains unmatched pending arguments and bounds only the historical confirmed overview', () => {
    const history = [...turn('pending', 'approval_required'),
      ...Array.from({ length: 10 }, (_, index) => turn(`done-${index}`, 'success', { ...args, content: `Another ${index}` })).flat()];
    const summary = summarizeReminderOperations(history, history.length, 'owner');
    expect(summary.pending.map(operation => operation.callId)).toEqual(['pending']);
    expect(summary.recentConfirmed.map(operation => operation.callId)).toEqual(['done-5', 'done-6', 'done-7', 'done-8', 'done-9']);
  });

  it('rejects pending tool transcripts and forged summary authority', () => {
    expect(() => summarizeReminderOperations(turn('pending').slice(0, 2), 1, 'owner')).toThrow();
    const summary = summarizeReminderOperations(turn('ok'), 3, 'owner');
    expect(reminderOperationalSummarySchema.safeParse({ ...summary, grantsAuthorization: true }).success).toBe(false);
    expect(reminderOperationalSummarySchema.safeParse({ ...summary, freshness: 'fresh' }).success).toBe(false);
  });

  it('keeps old pending records when the recent window excludes their original protocol batch', () => {
    const history = [...turn('old', 'approval_required'), ...turn('a', 'failed'), ...turn('b', 'failed'), ...turn('c', 'failed')];
    const prepared = prepareReminderContext(history, 'owner', 'Persona', 9, () => true);
    expect(prepared.omittedMessages).toBe(3);
    expect(prepared.messages).toHaveLength(10);
    expect(summaryOf(prepared.messages).pending[0]?.callId).toBe('old');
    expect(aiTranscriptSchema.safeParse(prepared.messages).success).toBe(true);
    expect(history).toHaveLength(12);
  });

  it('preserves the longest fitting window and measures the summary inside the complete request', () => {
    const history = Array.from({ length: 6 }, (_, index) => turn(`turn-${index}`, 'failed')).flat();
    const inspect = vi.fn((messages: readonly AIMessage[]) => messages.length <= 13);
    const prepared = prepareReminderContext(history, 'owner', 'Persona', 64, inspect);
    expect(prepared.omittedMessages).toBe(6);
    expect(prepared.messages).toHaveLength(13);
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(summaryOf(prepared.messages).omittedMessages).toBe(6);
  });

  it('returns essential context when its summary cannot fit rather than deleting pending state', () => {
    const history = [...turn('old', 'indeterminate'), ...turn('a', 'failed'), ...turn('b', 'failed'), ...turn('c', 'failed')];
    const prepared = prepareReminderContext(history, 'owner', 'Persona', 64, () => false);
    expect(prepared.omittedMessages).toBe(3);
    expect(summaryOf(prepared.messages).pending[0]?.status).toBe('indeterminate');
    expect(() => prepareReminderContext(history, 'owner', 'Persona', 8, () => true)).toThrow('recent turns exceed');
  });

  it('bounded productivity summarizes earlier dialogue but retains pending states and the full active tool pair', () => {
    const history = [...turn('pending', 'indeterminate'), ...turn('a', 'failed'), ...turn('active', 'success')];
    const original = structuredClone(history);
    const prepared = prepareProductivityContext(history, 'owner', 'Persona', 64, messages => messages.length <= 4, 1);
    expect(prepared.omittedMessages).toBe(6);
    expect(prepared.messages.slice(1)).toEqual(turn('active', 'success'));
    expect(summaryOf(prepared.messages).pending[0]?.status).toBe('indeterminate');
    expect(aiTranscriptSchema.safeParse(prepared.messages).success).toBe(true);
    expect(history).toEqual(original);
  });

  it('never derives write authorization from an old pending summary', async () => {
    const s = runner(response, { maxHistoryMessages: 10 });
    const history = [...turn('old', 'approval_required'), ...turn('a', 'failed'), ...turn('b', 'failed'), ...turn('c', 'failed')];
    const result = await s.runner.run('Hazlo', context, { userId: context.userId, history, references: [], handledRequestIds: ['old-request'] });
    expect(summaryOf(s.provider.requests[0]!.messages).pending[0]?.callId).toBe('old');
    expect(result.uiPayload.items[0]?.status).toBe('approval_required');
    expect(s.execute).not.toHaveBeenCalled();
    expect(result.conversation.history.slice(0, history.length)).toEqual(history);
    expect(result.conversation.handledRequestIds).toEqual(['old-request', 'current']);
  });

  it('finishes with a paired receipt when later continuation cannot fit the message ceiling', async () => {
    const s = runner(response, { continuation: 'observation_driven', maxHistoryMessages: 3, authorizeWrite: async () => true });
    const result = await s.runner.run('Crea', context);
    expect(result.uiPayload.items[0]?.status).toBe('success');
    expect(result.uiPayload.notices).toEqual(['limit_reached']);
    expect(aiTranscriptSchema.safeParse(result.conversation.history).success).toBe(true);
    expect(s.provider.requests).toHaveLength(1);
    expect(s.execute).toHaveBeenCalledTimes(1);
  });

  it('stops before inference when essential input exceeds the route limit', async () => {
    const s = runner(response, { maxInputTokens: 20, estimateInputTokens: () => 21 });
    expect((await s.runner.run('Crea', context)).uiPayload.notices).toEqual(['limit_reached']);
    expect(s.provider.requests).toHaveLength(0);
    expect(s.execute).not.toHaveBeenCalled();
  });

  it('rejects actual input-token overruns before dispatch even if the estimator undercounts', async () => {
    const s = runner(response, { maxInputTokens: 20, estimateInputTokens: () => 5, authorizeWrite: async () => true });
    expect((await s.runner.run('Crea', context)).uiPayload.notices).toEqual(['limit_reached']);
    expect(s.provider.requests).toHaveLength(1);
    expect(s.execute).not.toHaveBeenCalled();
  });
});
