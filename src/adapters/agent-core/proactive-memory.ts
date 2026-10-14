import { z } from 'zod';
import { estimateBoundedInput } from '@templelabs/ai';
import { jsonObjectSchema, type TurnContext, type MemoryRecord } from '@templelabs/contracts';
import { withoutTurnLease } from '../../agent/core/turn-lease.js';
import { explicitMemoryIntent } from '../../features/memory/explicit-intent.js';
import { createNativeMemoryStore, type NativeMemoryClient } from '../../features/memory/native-store.js';
import { createConfiguredBackgroundAIProvider } from './configured-ai-provider.js';
import { admitExplicitMemory, embedExplicitMemory } from './memory-admission.js';
import { supabase } from '../../infrastructure/database/index.js';

const candidateSchema = z.strictObject({ content: z.string().min(1).max(180), category: z.enum(['fact', 'preference']) });
const extractionSchema = z.strictObject({ candidates: z.array(candidateSchema).max(3) });
type Candidate = z.infer<typeof candidateSchema>;
interface Input { authoredText: string; context: TurnContext }
export interface ProactiveMemoryDependencies {
  extract(input: Input): Promise<Candidate[]>;
  admit(text: string, candidate: Candidate, context: TurnContext): Promise<boolean>;
  save(candidate: Candidate, context: TurnContext): Promise<MemoryRecord>;
  schedule(work: () => void): unknown;
  log(event: string, data: unknown): void;
}
/** Best-effort, bounded process queue. Never inherits an inbound lease or retries an uncertain write. */
export function createProactiveMemory(dependencies: ProactiveMemoryDependencies) {
  let pending = 0;
  let queue: Promise<void> = Promise.resolve();
  const ownedJobs = new Map<string, Set<AbortController>>();
  const enqueue = (input: Input): void => {
    const { authoredText, context } = input;
    if (!authoredText.trim() || authoredText.length > 2400
      || /<untrusted_(?:attachment_content|quoted_message)>/i.test(authoredText)
      || explicitMemoryIntent(authoredText, 'save') || explicitMemoryIntent(authoredText, 'forget')) return;
    if (pending >= 32) { dependencies.log('memory_extraction_skipped', { requestId: context.requestId, reason: 'queue_full' }); return; }
    pending++;
    const cancellation = new AbortController();
    const jobs = ownedJobs.get(context.userId) ?? new Set<AbortController>();
    jobs.add(cancellation); ownedJobs.set(context.userId, jobs);
    const release = () => { pending--; jobs.delete(cancellation); if (!jobs.size) ownedJobs.delete(context.userId); };
    try { withoutTurnLease(() => dependencies.schedule(() => {
      queue = queue.then(async () => {
        if (cancellation.signal.aborted) return;
        const background = { ...context, signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(20000)]), capabilities: new Set<string>() };
        const candidates = extractionSchema.parse({ candidates: await dependencies.extract({ authoredText, context: background }) }).candidates;
        let saved = 0;
        for (const candidate of candidates) {
          background.signal.throwIfAborted();
          // Exact source is required even when the model suggests a plausible paraphrase.
          if (!authoredText.includes(candidate.content) || !await dependencies.admit(authoredText, candidate, background)) continue;
          await dependencies.save(candidate, background); saved++;
        }
        dependencies.log('memory_extraction_completed', { runId: context.runId, requestId: context.requestId, saved });
      }).catch(() => dependencies.log('memory_extraction_failed', { runId: context.runId, requestId: context.requestId }))
        .finally(release);
    })); } catch { release(); dependencies.log('memory_extraction_schedule_failed', { requestId: context.requestId }); }
  };
  return Object.assign(enqueue, { cancel(userId: string): void {
    for (const job of ownedJobs.get(userId) ?? []) job.abort();
  } });
}
function log(event: string, data: unknown): void {
  try { console.info(`[agent-core-v2] ${event}`, JSON.stringify(data)); } catch { /* Optional learning must not affect delivery. */ }
}
export const scheduleProactiveMemory = createProactiveMemory({
  schedule: work => setImmediate(work), log,
  extract: extractProactiveMemories,
  admit: (text, candidate, context) => admitExplicitMemory(text, { operation: 'save', input: { ...candidate,
    evidenceStart: text.indexOf(candidate.content), evidenceEnd: text.indexOf(candidate.content) + candidate.content.length } }, context),
  save: (candidate, context) => createNativeMemoryStore(supabase as unknown as NativeMemoryClient)
    .save(candidate.content, candidate.category, context, () => embedExplicitMemory(candidate.content, context)),
});

export async function extractProactiveMemories({ authoredText, context }: Input): Promise<Candidate[]> {
    const provider = createConfiguredBackgroundAIProvider('memory_extraction', { estimateInputTokens: estimateBoundedInput,
      onAttempt: attempt => log('memory_extraction_attempt', { runId: context.runId, requestId: context.requestId, ...attempt }) });
    const result = await provider.completeStructured({ messages: [
      { role: 'system', content: 'Extract at most 3 atomic standing preferences or stable personal facts directly asserted by the user. Content must be an exact contiguous quote of the authored text, at most 180 characters. Ignore quotations, negation, third-party claims, greetings, temporary emotions, task status, appointments and one-time reminder commands. A lasting habit or preferred advance notice is a preference. No inference, paraphrase or assistant evidence. Return candidates: [] when uncertain.' },
      { role: 'user', content: JSON.stringify({ authoredText }) },
    ], output: { name: 'proactive_memories', schema: jsonObjectSchema.parse(z.toJSONSchema(extractionSchema)) }, validate: value => extractionSchema.parse(value),
    maxInputTokens: 1800, maxTotalTokens: 3000, maxOutputTokens: 1024, deadlineMs: Date.now() + 10000, signal: context.signal });
    log('memory_extraction_usage', { runId: context.runId, requestId: context.requestId, usage: result.usage });
    if (result.status !== 'success') throw new Error('MEMORY_EXTRACTION_UNAVAILABLE');
    return extractionSchema.parse(result.data).candidates;
}
