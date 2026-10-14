import { getWorkingMemory, saveWorkingMemory } from '../core/working-memory.js';
import { createClarificationFlow } from './clarification-state.js';

export const { hydrateClarificationStateFromHistory, getClarificationStateSnapshot } = createClarificationFlow({
  getWorkingMemory: (...args) => getWorkingMemory(...args),
  saveWorkingMemory: (...args) => saveWorkingMemory(...args),
  now: () => Date.now(),
});


