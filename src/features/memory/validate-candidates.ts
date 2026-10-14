// Legacy completion wiring; semantic admission executes from emitted TypeScript.
import { callChatCompletion } from '../../agent/providers/client.js';
import { createMemoryAdmission } from './memory-admission.js';
export const { validateMemoryCandidates } = createMemoryAdmission(() => callChatCompletion as import('../../agent/orchestration/observed-target-resolution.js').ObservedTargetCompletion);


