import { AsyncLocalStorage } from 'node:async_hooks';
export const MEMORY_EMBEDDING_DIMENSIONS = 768;
export interface EmbeddingProvider {
  readonly model: string;
  embed(input: string | readonly string[]): Promise<number[][] | null>;
}
interface QueryContext { userId: string; entries: Map<string,Promise<number[] | null>> }
/** Provider-independent ephemeral reuse; persistence and save embeddings are never cached. */
export function createEmbeddingService(provider: EmbeddingProvider) {
  const queryContext = new AsyncLocalStorage<QueryContext | undefined>();
  function withQueryEmbeddingScope<T>(userId: string,work: () => T): T {
    return queryContext.run({ userId,entries:new Map() },work);
  }
  function captureQueryEmbeddingScope<A extends unknown[],R>(work: (...args: A) => R) {
    const context = queryContext.getStore();
    return (...args: A): R => queryContext.run(context,() => work(...args));
  }
  async function generateEmbeddings(texts: readonly unknown[]): Promise<number[][] | null> {
    const input = (Array.isArray(texts) ? texts : []).map(text => typeof text === 'string' ? text.trim() : '');
    if (!input.length || input.some(text => !text)) return null;
    return provider.embed(input);
  }
  async function generateEmbedding(text: unknown,{ queryOwner }: { queryOwner?: string } = {}): Promise<number[] | null> {
    if (typeof text !== 'string' || !text.trim()) return null;
    const cleanText = text.trim(),context = queryContext.getStore();
    const requestVector = async () => (await provider.embed(cleanText))?.[0] ?? null;
    if (!queryOwner || context?.userId !== queryOwner) return requestVector();
    const key = JSON.stringify([queryOwner,provider.model,MEMORY_EMBEDDING_DIMENSIONS,cleanText]);
    let pending = context.entries.get(key);
    if (!pending) {
      if (context.entries.size >= 32) context.entries.delete(context.entries.keys().next().value!);
      pending = requestVector().then(vector => {
        if (!vector && context.entries.get(key) === pending) context.entries.delete(key);
        return vector;
      },error => {
        if (context.entries.get(key) === pending) context.entries.delete(key);
        throw error;
      });
      context.entries.set(key,pending);
    }
    const vector = await pending;
    return vector ? vector.slice() : null;
  }
  return { withQueryEmbeddingScope,captureQueryEmbeddingScope,generateEmbeddings,generateEmbedding };
}
