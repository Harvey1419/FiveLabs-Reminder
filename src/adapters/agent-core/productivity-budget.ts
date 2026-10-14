/** Bounded production policy: per-request input is distinct from the whole-turn budget. */
export const productivityBudget = Object.freeze({
  initialTools: ['task_create', 'reminder_create'] as const,
  finishWithVerifiedResults: true,
  maxInputTokens: 2500, maxTotalTokens: 20000, maxModelSteps: 10, maxToolCalls: 10,
  maxOutputTokens: 768, timeoutMs: 45000, continuationReserveTokens: 256,
});
