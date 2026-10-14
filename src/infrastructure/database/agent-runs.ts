// Compatibility wiring. Persistence logic is compiled from strict TypeScript.
import { supabase } from './index.js';
import { createAgentRunPersistence } from './agent-run-persistence.js';
function isDatabaseConfigured() {
  const url = process.env.SUPABASE_URL || '', secret = process.env.SUPABASE_SECRET || '';
  return Boolean(url && !url.includes('placeholder') && secret && !secret.includes('placeholder') && typeof supabase?.from === 'function');
}
// Resolve lazily: index.js re-exports this module before initializing the shared client.
export const { resetInMemoryAgentRuns, clearAgentRunsForUser, createAgentRunInDb, getActiveRunFromDb, updateAgentRunInDb, updateAgentRunIfStatusFromDb, cancelActiveInputRunFromDb, stagePreparedActionsInDb, getPreparedActionsFromDb, updatePreparedActionInDb, recordExecutionEventInDb } = createAgentRunPersistence(() => supabase as unknown as ReturnType<Parameters<typeof createAgentRunPersistence>[0]>,isDatabaseConfigured);


