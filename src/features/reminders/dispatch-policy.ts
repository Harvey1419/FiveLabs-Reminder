// Legacy completion wiring; reduction and compilation execute from emitted TypeScript.
import { callChatCompletion } from '../../agent/providers/client.js';
import { createDispatchPolicyCompiler } from './dispatch-policy-compiler.js';
export { reduceDispatchRules } from './dispatch-policy-compiler.js';
export const { compileDispatchPolicy } = createDispatchPolicyCompiler(() => callChatCompletion as import('../../agent/orchestration/observed-target-resolution.js').ObservedTargetCompletion);


