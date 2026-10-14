import 'dotenv/config';

import { supabase } from '../../src/infrastructure/database/index.js';
import { buildMemoryEmbeddingDocument } from '../../src/infrastructure/database/memories.js';
import { generateEmbeddings, MEMORY_EMBEDDING_MODEL } from '../../src/integrations/ai/embeddings.js';

interface MemoryProjection { id: string; topic_key: string | null; content: string }
interface ReindexResult { data: MemoryProjection[] | null; error: unknown }
interface ReindexQuery extends PromiseLike<ReindexResult> {
  select(columns: string): ReindexQuery;
  eq(column: string, value: string | boolean): ReindexQuery;
  order(column: string, options: { ascending: boolean }): ReindexQuery;
  range(from: number, to: number): ReindexQuery;
  update(payload: { embedding: readonly number[] | undefined }): ReindexQuery;
}
interface ReindexClient { from(table: 'memories'): ReindexQuery }
// The DB barrel exposes a reminder-specific view; this command consumes the SDK's memory projection/range port.
const database = supabase as unknown as ReindexClient;

const APPLY = process.argv.includes('--apply');
const PAGE_SIZE = 500;
const EMBEDDING_BATCH_SIZE = 32;

async function loadActiveMemories() {
  const rows: MemoryProjection[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await database
      .from('memories')
      .select('id, topic_key, content')
      .eq('is_active', true)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

async function updateBatch(batch: MemoryProjection[]) {
  const documents = batch.map((row) => buildMemoryEmbeddingDocument(row.topic_key, row.content));
  const embeddings = await generateEmbeddings(documents);
  if (!embeddings || embeddings.length !== batch.length) {
    throw new Error(`Embedding batch returned ${embeddings?.length || 0}/${batch.length} vectors.`);
  }

  const updates = await Promise.all(batch.map((row, index) => (
    database
      .from('memories')
      .update({ embedding: embeddings[index] })
      .eq('id', row.id)
      .eq('is_active', true)
  )));
  const failed = updates.find(({ error }) => error);
  if (failed?.error) throw failed.error;
}

const memories = await loadActiveMemories();
console.log(`[memory-reindex] active=${memories.length} model=${MEMORY_EMBEDDING_MODEL} apply=${APPLY}`);

if (!APPLY) {
  console.log('[memory-reindex] Dry run only. Re-run with --apply to replace active-memory search vectors.');
  process.exit(0);
}

for (let offset = 0; offset < memories.length; offset += EMBEDDING_BATCH_SIZE) {
  const batch = memories.slice(offset, offset + EMBEDDING_BATCH_SIZE);
  await updateBatch(batch);
  console.log(`[memory-reindex] updated=${Math.min(offset + batch.length, memories.length)}/${memories.length}`);
}

console.log('[memory-reindex] complete');
