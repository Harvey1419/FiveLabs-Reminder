import { productivityBudget } from './productivity-budget.js';

/** Enabled by the host option or AGENT_CORE_NATIVE_TOOLS=true.
 * Full authorized tool schemas stay available in every model request.
 */
export const nativeProductivityPolicy = Object.freeze({
  ...productivityBudget,
  nativeToolCalling: true,
  discoverTools: false,
  structuredDecisions: false,
  finishWithVerifiedResults: false,
  continuation: 'observation_driven' as const,
  maxInputTokens: 8000,
  maxTotalTokens: 40000,
});
