import { describe, expect, it, vi } from 'vitest';
import { MockAIProvider, OpenRouterProvider, estimateBoundedInput } from '@templelabs/ai';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import { createReminderTools, ToolRegistry } from '@templelabs/tools';
import { createSyntheticReminders, runConversation } from '../../../scripts/evals/v2-fluent-conversation.js';
import { createBudgetedTransport } from '../../../scripts/evals/live-evaluation-budget.js';
import { context as fixture } from './productivity-fixtures.js';
import type { TurnContext } from '@templelabs/contracts';

const context: TurnContext = { ...fixture, userId: 'fluent-eval-synthetic-owner' };
const opening = 'Recuérdame preparar reunión hoy a las 4 PM y enviar informe a las 9 AM, pero no sé si hoy o mañana';
function setup() {
  const store = createSyntheticReminders();
  const execute = vi.fn(store.execute);
  const tool = createReminderTools({ execute })[0];
  return { store, execute, tool };
}

describe('V2 mixed temporal semantics through public tools and runner', () => {
  it('executes the corrected typed wire through provider, durable host, receipts and checkpoints in two offline turns', async () => {
    const decisions = [
      { name: 'reminder_create', arguments: { content: 'Preparar reunión', relativeDayTime: { day: 'today', hour: 16, minute: 0 }, turnDisposition: 'continue' } },
      { name: 'conversation_clarify', arguments: { domain: 'reminders', missing: 'today_or_tomorrow' } },
      { name: 'reminder_create', arguments: { content: 'Enviar informe', relativeDayTime: { day: 'tomorrow', hour: 9, minute: 0 }, turnDisposition: 'finish' } },
    ];
    const rates = { 'synthetic/temporal': { prompt: 1e-8, completion: 1e-8 } };
    let step = 0;
    const requests: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(init?.method).toBe('POST');
      const payload: unknown = JSON.parse(String(init?.body)); requests.push(payload);
      const decision = decisions[step++]!;
      return new Response(JSON.stringify({ id: `synthetic-temporal-${step}`, model: 'synthetic/temporal',
        usage: { prompt_tokens: 100, completion_tokens: 30, cost: 0.00001 },
        choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: `step-${step}`, type: 'function',
          function: { name: decision.name, arguments: JSON.stringify(decision.arguments) } }] } }],
      }), { status: 200 });
    });
    const budget = createBudgetedTransport({ fetch, rates, maxCalls: 6, maxUsd: 0.02 });
    const provider = new OpenRouterProvider({ apiKey: 'synthetic-only', routes: [{ id: 'primary', model: 'synthetic/temporal', providers: ['synthetic'], timeoutMs: 1000 }], fetch: budget.fetch, estimateInputTokens: estimateBoundedInput });
    const result = await runConversation({ directed: true, forTurn: () => provider.forTurn(), rates, budgetReport: budget.report });
    expect(result, JSON.stringify({ turns: result.turns, budget: result.budget }, null, 2)).toMatchObject({ passedTurns: 2, failedChecks: 0, incomplete: false, liveProof: false, directedProof: false });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result.receipts).toHaveLength(2);
    expect(result.turns[0]!.operations).toHaveLength(1);
    expect(result.turns[1]!.operations).toHaveLength(1);
    expect(result.finalRecords.map(record => record.sendAt)).toEqual(['2026-10-11T21:00:00.000Z', '2026-10-12T14:00:00.000Z']);
    expect(result.turns[1]!.after[0]).toEqual(result.turns[0]!.after[0]);
    expect(result.turns[0]!.reply.endsWith('¿El recordatorio pendiente es para hoy o para mañana?')).toBe(true);
    expect(result.turns[1]!.reply).toContain('9:00 AM');
    expect(result.turns[1]!.reply).not.toContain('Preparar reunión');
    expect(result.turns.every(turn => turn.checks.find(check => check.name === 'host reply and checkpoint agree')?.pass)).toBe(true);
    expect(JSON.stringify(requests[2])).toContain('mañana');
    expect(budget.report()).toMatchObject({ calls: 3, reservedUsd: 0, blockedReason: null });
  });
  it('reproduces the recorded bare-clock 9 PM result without pretending the old arguments contain tomorrow or AM', async () => {
    const s = setup();
    const result = await s.tool.execute({ content: 'Enviar informe', unqualifiedLocalTime: { hour: 9, minute: 0 } }, context, 'old-wire');
    expect(result.status).toBe('success');
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.store.snapshot()).toMatchObject([{ sendAt: '2026-10-12T02:00:00.000Z' }]);
  });
  it.each([
    ['today', 16, '2026-10-11T21:00:00.000Z'],
    ['tomorrow', 9, '2026-10-12T14:00:00.000Z'],
    ['tomorrow', 21, '2026-10-13T02:00:00.000Z'],
  ])('preserves explicit %s and hour %s without modulo12 or UTC calculation by the model', async (day, hour, expected) => {
    const s = setup();
    const result = await s.tool.execute({ content: 'Explicit schedule', relativeDayTime: { day, hour, minute: 0 } }, context, 'explicit');
    expect(result.status).toBe('success');
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.execute.mock.calls[0]?.[0]).toEqual({ operation: 'create', input: { content: 'Explicit schedule', targetTimeIso: expected } });
    expect(s.store.receipts).toHaveLength(1);
    expect(s.store.snapshot()).toMatchObject([{ sendAt: expected }]);
  });
  it.each([
    { day: 'today', hour: 9, minute: 0 },
    { day: 'yesterday', hour: 9, minute: 0 },
    { day: 'tomorrow', hour: 24, minute: 0 },
    { day: 'tomorrow', hour: 9, minute: 60 },
  ])('rejects invalid or past explicit schedule %j without writes, receipts or domain dispatch', async relativeDayTime => {
    const s = setup();
    const before = s.store.snapshot();
    const result = await s.tool.execute({ content: 'No write', relativeDayTime }, context, 'invalid');
    expect(result.status).toBe('validation_failed');
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.store.snapshot()).toEqual(before);
    expect(s.store.operations).toEqual([]);
    expect(s.store.receipts).toEqual([]);
  });
  it('does not roll a nonexistent DST local time onto another day', async () => {
    const s = setup();
    const result = await s.tool.execute({ content: 'No DST drift', relativeDayTime: { day: 'tomorrow', hour: 2, minute: 30 } },
      { ...context, timezone: 'America/New_York', referenceTimeIso: '2026-03-07T17:00:00Z' }, 'gap');
    expect(result.status).toBe('validation_failed');
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.store.snapshot()).toEqual([]);
    expect(s.store.receipts).toEqual([]);
  });
  it('chooses the first future exact wall-clock occurrence during a repeated DST hour', async () => {
    const s = setup();
    const result = await s.tool.execute({ content: 'DST fold', relativeDayTime: { day: 'today', hour: 1, minute: 30 } },
      { ...context, timezone: 'America/New_York', referenceTimeIso: '2026-11-01T05:45:00Z' }, 'fold');
    expect(result.status).toBe('success');
    expect(s.store.snapshot()).toMatchObject([{ sendAt: '2026-11-01T06:30:00.000Z' }]);
  });
  it.each([
    { targetTimeIso: '2026-10-12T14:00:00Z' },
    { delayMinutes: 5 },
    { unqualifiedLocalTime: { hour: 9, minute: 0 } },
  ])('rejects mixed clock alternatives %j before dispatch', async other => {
    const s = setup();
    const result = await s.tool.execute({ content: 'No mixed input', relativeDayTime: { day: 'tomorrow', hour: 9, minute: 0 }, ...other }, context, 'mixed');
    expect(result).toMatchObject({ status: 'validation_failed', code: 'INVALID_ARGUMENTS' });
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.store.snapshot()).toEqual([]);
    expect(s.store.receipts).toEqual([]);
  });
  it.each([
    [{ targetTimeIso: '2026-10-12T14:00:00Z' }, '2026-10-12T14:00:00Z'],
    [{ delayMinutes: 5 }, '2026-10-11T17:54:00.000Z'],
    [{ unqualifiedLocalTime: { hour: 16, minute: 0 } }, '2026-10-11T21:00:00.000Z'],
  ])('preserves the existing alternative %j', async (input, expected) => {
    const s = setup();
    const result = await s.tool.execute({ content: 'Existing behavior', ...input }, context, 'existing');
    expect(result.status).toBe('success');
    expect(s.store.snapshot()).toMatchObject([{ sendAt: expected }]);
    expect(s.store.receipts).toHaveLength(1);
  });
  it.each([false, true])('retains per-item and short-answer semantics in executable=%s actual request context', async executable => {
    const s = setup();
    const provider = new MockAIProvider([{ response: { message: { role: 'assistant', content: 'Question only.', toolCalls: [] },
      stopReason: 'completed', usage: { inputTokens: 10, outputTokens: 10 } } }]);
    const runner = new ProductivityTurnRunner(provider, new ToolRegistry(createReminderTools({ execute: s.execute })), {
      compactObservations: true, initialTools: ['reminder_create'], maxInputTokens: 2500,
      estimateInputTokens: input => executable && JSON.stringify(input).includes('Executive Personal Assistant') ? 3000 : 100,
    });
    const result = await runner.run('mañana', context, { userId: context.userId, reminders: [], tasks: [], events: [], handledRequestIds: [],
      history: [{ role: 'user', content: opening }, { role: 'assistant', content: '¿El recordatorio pendiente es para hoy o para mañana?', toolCalls: [] }] });
    expect(result.uiPayload.items).toEqual([]);
    const system = provider.requests[0]!.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    expect(system).toContain('Execute clear independent actions before asking only for another action’s missing fields.');
    expect(system).toContain('A current short answer resolves only the preceding question’s missing fields; preserve explicit dates and AM/PM.');
    expect(system).toContain('relativeDayTime');
    expect(system).toContain('not authorization');
    expect(system.includes('Executive Personal Assistant')).toBe(!executable);
    expect(JSON.stringify(provider.requests[0]!.messages)).toContain('mañana');
    expect(s.execute).not.toHaveBeenCalled();
  });
});
