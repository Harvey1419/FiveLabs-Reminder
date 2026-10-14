// Legacy host wiring; ordered turn execution runs from emitted TypeScript.
import { executeTool } from '../tools/index.js';
import { createExecutionFact } from '../core/execution-facts.js';
import { getWorkingMemory } from '../core/working-memory-store.js';
import { updateWorkingMemoryFromExecution, updateWorkingMemoryFromFacts } from '../core/working-memory-execution.js';
import {
  extractMultipleOrdinals,
} from '../core/context-reference.js';
import {
  findOutOfRangeTaskOrdinalTargets,
  pinReminderCancellationTargets,
  pinTaskMutationTargets,
} from './context-target-pinner.js';
import { cancelSupersededInputRun, createApprovalRun, createInputRun } from '../core/agent-run.js';
import { buildDomainCall, failedResult, intentTarget } from './domain-call.js';
import { resolveObservedTarget } from './resolve-observed-target.js';
import { detectLanguageFromText } from '../../shared/language-detection.js';

import { createIntentExecutor } from './turn-intent-executor.js';
export const { executeTurnIntent,inferIntentFromTool } = createIntentExecutor({
  executeTool: ((...args: Parameters<typeof executeTool>) => executeTool(...args)) as unknown as Parameters<typeof createIntentExecutor>[0]['executeTool'],
  createExecutionFact: ((...args: Parameters<typeof createExecutionFact>) => createExecutionFact(...args)) as unknown as Parameters<typeof createIntentExecutor>[0]['createExecutionFact'],
  getWorkingMemory: ((...args: Parameters<typeof getWorkingMemory>) => getWorkingMemory(...args)) as unknown as Parameters<typeof createIntentExecutor>[0]['getWorkingMemory'],
  updateWorkingMemoryFromExecution: ((...args: Parameters<typeof updateWorkingMemoryFromExecution>) => updateWorkingMemoryFromExecution(...args)) as unknown as Parameters<typeof createIntentExecutor>[0]['updateWorkingMemoryFromExecution'],
  updateWorkingMemoryFromFacts: ((...args: Parameters<typeof updateWorkingMemoryFromFacts>) => updateWorkingMemoryFromFacts(...args)) as unknown as Parameters<typeof createIntentExecutor>[0]['updateWorkingMemoryFromFacts'],
  extractMultipleOrdinals: ((...args: Parameters<typeof extractMultipleOrdinals>) => extractMultipleOrdinals(...args)) as unknown as Parameters<typeof createIntentExecutor>[0]['extractMultipleOrdinals'],
  pinReminderCancellationTargets: ((...args: Parameters<typeof pinReminderCancellationTargets>) => pinReminderCancellationTargets(...args)) as unknown as Parameters<typeof createIntentExecutor>[0]['pinReminderCancellationTargets'],
  pinTaskMutationTargets: ((...args: Parameters<typeof pinTaskMutationTargets>) => pinTaskMutationTargets(...args)) as unknown as Parameters<typeof createIntentExecutor>[0]['pinTaskMutationTargets'],
  findOutOfRangeTaskOrdinalTargets: ((...args: Parameters<typeof findOutOfRangeTaskOrdinalTargets>) => findOutOfRangeTaskOrdinalTargets(...args)) as unknown as Parameters<typeof createIntentExecutor>[0]['findOutOfRangeTaskOrdinalTargets'],
  createInputRun: ((...args: Parameters<typeof createInputRun>) => createInputRun(...args)) as unknown as Parameters<typeof createIntentExecutor>[0]['createInputRun'],
  cancelSupersededInputRun: ((...args: Parameters<typeof cancelSupersededInputRun>) => cancelSupersededInputRun(...args)) as unknown as Parameters<typeof createIntentExecutor>[0]['cancelSupersededInputRun'],
  createApprovalRun: ((...args: Parameters<typeof createApprovalRun>) => createApprovalRun(...args)) as unknown as Parameters<typeof createIntentExecutor>[0]['createApprovalRun'],
  buildDomainCall: ((...args: Parameters<typeof buildDomainCall>) => buildDomainCall(...args)) as unknown as Parameters<typeof createIntentExecutor>[0]['buildDomainCall'],
  failedResult: ((...args: Parameters<typeof failedResult>) => failedResult(...args)) as unknown as Parameters<typeof createIntentExecutor>[0]['failedResult'],
  intentTarget: ((...args: Parameters<typeof intentTarget>) => intentTarget(...args)) as unknown as Parameters<typeof createIntentExecutor>[0]['intentTarget'],
  resolveObservedTarget: ((...args: Parameters<typeof resolveObservedTarget>) => resolveObservedTarget(...args)) as unknown as Parameters<typeof createIntentExecutor>[0]['resolveObservedTarget'],
  detectLanguageFromText: ((...args: Parameters<typeof detectLanguageFromText>) => detectLanguageFromText(...args)) as unknown as Parameters<typeof createIntentExecutor>[0]['detectLanguageFromText'],
});


