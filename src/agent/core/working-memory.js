import { resolveContextReference } from './context-reference.js';
import { getWorkingMemory } from './working-memory-store.js';

export {
  saveWorkingMemory,
  getWorkingMemory,
  clearWorkingMemory,
  formatWorkingMemoryPrompt,
  sanitizeResponseText,
  tokenizeText,
} from './working-memory-store.js';

/**
 * Compatibility entry point for the remaining Calendar consumer.
 * Resolution semantics are owned exclusively by context-reference.js; Working
 * Memory provides state only and performs no conversational interpretation.
 */
export function resolveEntityReference({
  userOrPhone,
  reference,
  candidates = null,
  preferredType = null,
} = {}) {
  return resolveContextReference({
    reference,
    candidates,
    preferredType,
    workingMemory: getWorkingMemory(userOrPhone),
  });
}
