import {
  saveWorkingMemory,
  getWorkingMemory,
  clearWorkingMemory,
  getWorkingMemorySnapshot,
  hydrateWorkingMemoryFromHistory,
  formatWorkingMemoryPrompt as formatWorkingMemoryPromptBase,
  sanitizeResponseText,
  tokenizeText,
} from './working-memory-store.js';

export {
  saveWorkingMemory,
  getWorkingMemory,
  clearWorkingMemory,
  getWorkingMemorySnapshot,
  hydrateWorkingMemoryFromHistory,
  sanitizeResponseText,
  tokenizeText,
};

import { createWorkingMemoryPrompt } from './working-memory-acknowledgement.js';
export const { formatWorkingMemoryPrompt } = createWorkingMemoryPrompt({
  getWorkingMemory: (...args) => getWorkingMemory(...args),
  formatWorkingMemoryPromptBase: (...args) => formatWorkingMemoryPromptBase(...args),
});


