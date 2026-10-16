import { describe, expect, it } from 'vitest';
import { OpenRouterProvider, estimateBoundedInput } from '@templelabs/ai';
import { createBudgetedTransport } from '../../../scripts/evals/live-evaluation-budget.js';
import { runConversation, safeAttempt } from '../../../scripts/evals/v2-fluent-conversation.js';

describe('S3–S5 selection diagnostics through the public evaluator', () => {
  it.each(['conversation_clarify', 'reminder_read'])('retains the decision for rejected %s without another network attempt on unknown spend', async name => {
    let networkCalls = 0;
    const attempts: ReturnType<typeof safeAttempt>[] = [];
    const budget = createBudgetedTransport({ maxCalls: 60, maxUsd: 0.25,
      rates: { 'fixture/model': { prompt: 0.0000007, completion: 0.00000095 } },
      fetch: async () => {
        networkCalls++;
        return new Response(JSON.stringify({ error: { code: 502,
          message: `attempted to call tool '${name}' which was not in request.tools`,
          metadata: { failed_generation: 'PRIVATE_ARGUMENTS' } } }), { status: 200 });
      },
    });
    const source = new OpenRouterProvider({ apiKey: 'PRIVATE_KEY',
      routes: [{ id: 'primary', model: 'fixture/model', providers: ['fixture'], timeoutMs: 1000 }],
      fetch: budget.fetch, estimateInputTokens: estimateBoundedInput,
      onAttempt: attempt => { attempts.push(safeAttempt(attempt)); },
    });
    const report = await runConversation({ forTurn: () => source.forTurn(),
      budgetReport: budget.report, attempts });
    const first = report.turns[0]!;
    expect(first).toMatchObject({ toolSelections: [{ rejectedToolName: name,
      advertisedToolNames: ['tools_select', 'reminder_create', 'conversation_decide'], advertisedToolsTruncated: false,
      decision: name === 'reminder_read' ? 'reload_schema' : 'stop',
      reason: name === 'reminder_read' ? 'authorized_schema' : 'reserved_control', accountingComplete: false }] });
    expect(first.safeAttempts[0]).toMatchObject({ rejectedToolName: name, providerErrorCode: 502,
      advertisedToolNames: ['tools_select', 'reminder_create', 'conversation_decide'], failureClass: 'unadvertised_tool_rejection', usage: null });
    expect(networkCalls).toBe(1);
    expect(report.budget.calls).toBe(1);
    expect(report.budget.blockedReason).toBe('missing usage or provider error');
    expect(report.budget.reservedUsd).toBeGreaterThan(0);
    expect(report.liveProof).toBe(false);
    expect(report.incomplete).toBe(true);
    expect(first.operations).toEqual([]);
    expect(report.receipts).toEqual([]);
    expect(report.finalRecords).toEqual([]);
    expect(JSON.stringify(first.toolSelections)).not.toMatch(/PRIVATE|arguments|content|message/);
  });
});
