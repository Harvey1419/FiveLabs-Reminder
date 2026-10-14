import { clearAgentRunsForUser } from '../../infrastructure/database/agent-runs.js';
import { createWorkingMemoryStore } from './working-memory-cache.js';

export const { saveWorkingMemory, getWorkingMemory, clearWorkingMemory, getWorkingMemorySnapshot, hydrateWorkingMemoryFromHistory, formatWorkingMemoryPrompt } = createWorkingMemoryStore({
  clearAgentRunsForUser: value => clearAgentRunsForUser(value as Parameters<typeof clearAgentRunsForUser>[0]),
});
export { sanitizeResponseText, tokenizeText } from './working-memory-cache.js';


