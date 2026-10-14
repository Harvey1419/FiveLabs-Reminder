import { getWorkingMemory, saveWorkingMemory, clearWorkingMemory } from './working-memory-store.js';
import { createWorkingMemoryExecution } from './working-memory-outcomes.js';

export const { updateWorkingMemoryFromExecution, updateWorkingMemoryFromFacts } = createWorkingMemoryExecution({
  getWorkingMemory: (...args) => getWorkingMemory(...args),
  saveWorkingMemory: (...args) => saveWorkingMemory(...args),
  clearWorkingMemory: (...args) => clearWorkingMemory(...args),
});


