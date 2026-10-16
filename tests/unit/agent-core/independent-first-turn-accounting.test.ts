import { expect, it, vi } from 'vitest';
import type { AIResponse } from '@templelabs/contracts';
import { runConversation } from '../../../scripts/evals/v2-fluent-conversation.js';

it('S4/S5 actual evaluator fences a forced decision correction on unknown spend', async () => {
  let locked = false;
  const complete = vi.fn(async (): Promise<AIResponse> => {
    locked = true;
    return { message: { role: 'assistant', content: '¿Para cuándo?', toolCalls: [] }, stopReason: 'completed', usage: { inputTokens: 30, outputTokens: 10 } };
  });
  const report = await runConversation({ directed: true,
    forTurn: () => ({ capabilities: { toolCalling: true, structuredOutput: false }, complete }),
    budgetReport: () => ({ calls: Number(locked), chargedUsd: 0, reservedUsd: locked ? 0.01 : 0, blockedReason: locked ? 'unknown spend' : null, attempts: [] }),
  });
  expect(complete).toHaveBeenCalledTimes(1);
  expect(report.stoppedReason).toBe('unknown spend');
  expect(report.finalRecords).toEqual([]); expect(report.receipts).toEqual([]);
  expect(report.liveProof).toBe(false); expect(report.directedProof).toBe(false);
  expect(report.turns).toHaveLength(1); expect(report.turns[0]!.operations).toEqual([]);
  expect(report.turns[0]!.usage).toMatchObject({ accountingComplete: false, modelSteps: 2, inputTokens: 30, outputTokens: 10 });
});
