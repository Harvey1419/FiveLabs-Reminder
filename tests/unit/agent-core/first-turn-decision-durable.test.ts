import { describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider, estimateBoundedInput } from '@templelabs/ai';
import { productivityCheckpointSchema, type JsonObject } from '@templelabs/contracts';
import { runConversation } from '../../../scripts/evals/v2-fluent-conversation.js';
import { createBudgetedTransport } from '../../../scripts/evals/live-evaluation-budget.js';

// Real adapter/runner/durable presenter; only HTTP and domain storage are synthetic.
describe('first-turn decision through configured evaluator and durable checkpoints', () => {
  it('uses the active protocol in two mocked HTTP decisions and survives checkpoint JSON reload without replay', async () => {
    let step = 0; const requests: { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] }[] = [];
    const fakeFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as typeof requests[number]; requests.push(payload);
      expect(payload.tools.some(tool => tool.function.name === 'conversation_decide')).toBe(true);
      let decision: JsonObject;
      let create: JsonObject;
      if (step++ === 0) {
        decision = { ready: [{ key: 'meeting', tool: 'reminder_create' }], pending: { tool: 'reminder_create', missing: 'today_or_tomorrow',
          knownArguments: { content: 'Enviar informe', relativeDayTime: { hour: 9, minute: 0 } } } };
        create = { decisionItem: 'meeting', content: 'Preparar reunión', relativeDayTime: { day: 'today', hour: 16, minute: 0 } };
      } else {
        const text = payload.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
        const pendingId = /"lastPending":\{"id":"([^"]+)"/.exec(text)?.[1];
        expect(pendingId).toBeTruthy();
        expect(text).toContain('"hour":9');
        decision = { ready: [{ key: 'report', tool: 'reminder_create' }], resolution: { pendingId: pendingId!, key: 'report' } };
        create = { decisionItem: 'report', content: 'Enviar informe', relativeDayTime: { day: 'tomorrow', hour: 9, minute: 0 } };
      }
      return new Response(JSON.stringify({ id: `synthetic-decision-${step}`, model: 'synthetic/decision', usage: { prompt_tokens: 100, completion_tokens: 60, cost: 0.00001 },
        choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [
          { id: `plan-${step}`, type: 'function', function: { name: 'conversation_decide', arguments: JSON.stringify(decision) } },
          { id: `create-${step}`, type: 'function', function: { name: 'reminder_create', arguments: JSON.stringify(create) } },
        ] } }] }), { status: 200 });
    });
    const rates = { 'synthetic/decision': { prompt: 1e-8, completion: 1e-8 } };
    const budget = createBudgetedTransport({ fetch: fakeFetch, rates, maxCalls: 6, maxUsd: 0.02 });
    const provider = new OpenRouterProvider({ apiKey: 'synthetic-only', routes: [{ id: 'primary', model: 'synthetic/decision', providers: ['synthetic'], timeoutMs: 1000 }],
      fetch: budget.fetch, estimateInputTokens: estimateBoundedInput });
    const report = await runConversation({ directed: true, forTurn: () => provider.forTurn(), rates, budgetReport: budget.report });
    expect(report, JSON.stringify({ turns: report.turns, budget: report.budget })).toMatchObject({ passedTurns: 2, failedChecks: 0, incomplete: false, liveProof: false, directedProof: false });
    expect(fakeFetch).toHaveBeenCalledTimes(2); expect(report.receipts).toHaveLength(2);
    const a = productivityCheckpointSchema.parse(report.turns[0]!.checkpoints.at(-1)!.agentCoreProductivity);
    const b = productivityCheckpointSchema.parse(report.turns[1]!.checkpoints.at(-1)!.agentCoreProductivity);
    expect(a.phase).toBe('completed'); expect(a.completed!.conversation.pending).toMatchObject({ userId: report.userId, sourceRequestId: 'fluent-request-1', knownArguments: { relativeDayTime: { hour: 9, minute: 0 } } });
    expect(b.completed!.conversation).not.toHaveProperty('pending');
    expect(report.turns[0]!.operations).toHaveLength(1); expect(report.turns[1]!.operations).toHaveLength(1);
    expect(report.turns[1]!.after[0]).toEqual(report.turns[0]!.after[0]);
    expect(report.finalRecords.map(record => record.sendAt)).toEqual(['2026-10-11T21:00:00.000Z', '2026-10-12T14:00:00.000Z']);
    expect(report.turns.every(turn => turn.checks.find(check => check.name === 'host reply and checkpoint agree')?.pass)).toBe(true);
    expect(budget.report()).toMatchObject({ calls: 2, reservedUsd: 0, blockedReason: null });
  });
});
