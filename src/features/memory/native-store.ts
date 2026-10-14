import { createHash } from 'node:crypto';
import { z } from 'zod';
import { memoryRecordSchema, type MemoryRecord, type TurnContext } from '@templelabs/contracts';
interface Reply { data: unknown; error: unknown }
export interface NativeMemoryQuery extends PromiseLike<Reply> {
  select(columns: string): NativeMemoryQuery;
  insert(value: unknown): NativeMemoryQuery;
  delete(): NativeMemoryQuery;
  eq(column: string, value: unknown): NativeMemoryQuery;
  ilike(column: string, value: string): NativeMemoryQuery;
  order(column: string, options: { ascending: boolean }): NativeMemoryQuery;
  limit(count: number): NativeMemoryQuery;
  abortSignal(signal: AbortSignal): NativeMemoryQuery;
  maybeSingle(): PromiseLike<Reply>;
}
export interface NativeMemoryClient { from(table: 'memories'): NativeMemoryQuery }
export class MemoryStorageError extends Error {
  constructor(readonly writeStarted: boolean) { super(writeStarted ? 'MEMORY_WRITE_UNKNOWN' : 'MEMORY_READ_UNAVAILABLE'); }
}
const columns = 'id,user_id,content,category,topic_key,is_active';
const row = z.object({ id: z.string(), user_id: z.string(), content: z.string(), category: z.string(), topic_key: z.string().nullable(), is_active: z.boolean() });
export function createNativeMemoryStore(client: NativeMemoryClient) {
  const decode = (raw: unknown, context: TurnContext, status: MemoryRecord['status'] = 'active') => {
    const value = row.parse(raw);
    if (value.user_id !== context.userId || !value.is_active) throw new Error('MEMORY_OWNER_OR_STATE_MISMATCH');
    return memoryRecordSchema.parse({ id: value.id, content: value.content, category: value.category, topicKey: value.topic_key, status });
  };
  const scoped = (context: TurnContext) => client.from('memories').select(columns).eq('user_id', context.userId).eq('is_active', true)
    .abortSignal(AbortSignal.any([context.signal, AbortSignal.timeout(10000)]));
  return {
    async read(query: string | undefined, context: TurnContext) {
      let request = scoped(context);
      if (query) request = request.ilike('content', `%${query.replace(/[\\%_]/g, '\\$&')}%`);
      try {
        const result = await request.order('created_at', { ascending: false }).limit(5);
        if (result.error || !Array.isArray(result.data)) throw new Error('Missing memory read');
        return result.data.map(value => decode(value, context));
      } catch { throw new MemoryStorageError(false); }
    },
    async save(content: string, category: MemoryRecord['category'], context: TurnContext, embed: () => Promise<readonly number[] | null>) {
      let writeStarted = false;
      try {
        // Exact identity only: no inferred topic replacement or background reminder writes.
        const topicKey = 'explicit:' + createHash('sha256').update(JSON.stringify([category, content])).digest('hex');
        const prior = await scoped(context).eq('topic_key', topicKey).limit(2);
        if (prior.error || !Array.isArray(prior.data) || prior.data.length > 1) throw new Error('Invalid identity lookup');
        if (prior.data.length) {
          const existing = decode(prior.data[0], context);
          if (existing.content !== content || existing.category !== category) throw new Error('Memory identity mismatch');
          return existing;
        }
        const embedding = await embed(); context.signal.throwIfAborted();
        writeStarted = true;
        const result = await client.from('memories').insert({ user_id: context.userId, content, category, topic_key: topicKey, is_active: true,
          confidence: 1, embedding }).select(columns).abortSignal(context.signal).maybeSingle();
        if (result.error || !result.data) throw new Error('Missing memory write receipt');
        const saved = decode(result.data, context);
        if (saved.content !== content || saved.category !== category || saved.topicKey !== topicKey) throw new Error('Memory receipt mismatch');
        return saved;
      } catch { throw new MemoryStorageError(writeStarted); }
    },
    async forget(id: string, context: TurnContext, authorize?: (record: MemoryRecord) => Promise<boolean>) {
      let writeStarted = false;
      try {
        const prior = await scoped(context).eq('id', id).limit(1).maybeSingle();
        if (prior.error) throw new Error('Memory read unavailable');
        if (!prior.data) return null;
        const known = decode(prior.data, context);
        if (known.id !== id) throw new Error('Memory identity mismatch');
        if (authorize && !await authorize(known)) return null;
        context.signal.throwIfAborted();
        writeStarted = true;
        const result = await client.from('memories').delete().eq('user_id', context.userId).eq('id', id).eq('is_active', true).eq('content', known.content).eq('category', known.category)
          .select(columns).abortSignal(context.signal).maybeSingle();
        if (result.error) throw new Error('Memory deletion unknown');
        if (!result.data) return null;
        const deleted = decode(result.data, context, 'forgotten');
        if (deleted.id !== id || deleted.content !== known.content) throw new Error('Memory deletion receipt mismatch');
        return deleted;
      } catch { throw new MemoryStorageError(writeStarted); }
    },
  };
}
export type NativeMemoryStore = ReturnType<typeof createNativeMemoryStore>;
