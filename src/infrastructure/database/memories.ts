// Legacy host wiring; persistence and policy reconciliation execute from emitted TypeScript.
import { supabase } from './index.js';
import { generateEmbedding } from '../../integrations/ai/embeddings.js';
import { compileDispatchPolicy,reduceDispatchRules } from '../../features/reminders/dispatch-policy.js';
import { createMemoryPersistence } from './memory-persistence.js';
function isConfigured() {
  const url = process.env.SUPABASE_URL || '',secret = process.env.SUPABASE_SECRET || '';
  const method = supabase?.from as (typeof supabase.from & { _isMockFunction?: unknown; mock?: unknown });
  const isMock = Boolean(method?._isMockFunction || method?.mock);
  return Boolean((isMock || (url && !url.includes('placeholder') && secret && !secret.includes('placeholder'))) && typeof supabase?.from === 'function');
}
export const { buildMemoryEmbeddingDocument,selectMemorySearchResults,saveMemory,getActiveMemories,getStandingMemories,searchMemories,forgetMemories,forgetMemoriesByTopic,getReminderDispatchPolicy,getReminderConfirmationPreference,isReminderPolicyMemory,reconcileRemindersWithPolicy,triggerEagerReminderReconciliation } = createMemoryPersistence(() => supabase as unknown as ReturnType<Parameters<typeof createMemoryPersistence>[0]>,{ isConfigured,generateEmbedding,compileDispatchPolicy,reduceDispatchRules });


