import { AsyncLocalStorage } from 'node:async_hooks';
import { embeddingSpaceSchema } from '@templelabs/contracts';
import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from '@templelabs/ai';
import { LEGACY_MEMORY_SPACE } from './configured-endpoint-providers.js';

type Single = { readonly vector: readonly number[]; readonly space: EmbeddingResult['space'];
  readonly usage: EmbeddingResult['usage']; readonly reused: boolean };
const queries = new AsyncLocalStorage<{ owner: string; entries: Map<string, Promise<Single>> } | undefined>();
export function withMemoryEmbeddingScope<T>(owner: string, work: () => T): T {
  if (!owner) throw new Error('INVALID_QUERY_OWNER');
  return queries.run({ owner, entries: new Map() }, work);
}
export function captureMemoryEmbeddingScope<A extends unknown[], R>(work: (...args: A) => R): (...args: A) => R {
  const scope = queries.getStore(); return (...args) => queries.run(scope, () => work(...args));
}
/** Query vectors only: no database reads/writes or inference across a changed embedding space. */
export class MemoryEmbeddingClient {
  private readonly request: Omit<EmbeddingRequest, 'input' | 'space'>;
  constructor(private readonly provider: EmbeddingProvider, request: Omit<EmbeddingRequest, 'input' | 'space'>,
    private readonly now: () => number = Date.now) {
    this.request = { ...request };
    if (provider.space.id !== LEGACY_MEMORY_SPACE.id || provider.space.model !== LEGACY_MEMORY_SPACE.model
      || provider.space.dimensions !== LEGACY_MEMORY_SPACE.dimensions) throw new Error('MEMORY_EMBEDDING_SPACE_MISMATCH');
  }
  private fresh() {
    this.request.signal.throwIfAborted(); const clock = this.now();
    if (!Number.isFinite(clock) || !Number.isFinite(this.request.deadlineMs) || clock >= this.request.deadlineMs) throw new Error('EMBEDDING_DEADLINE');
  }
  private async requestVectors(input: string | readonly string[]): Promise<EmbeddingResult> {
    this.fresh();
    const normalized = typeof input === 'string' ? input.trim() : input.map(text => text.trim());
    const count = typeof normalized === 'string' ? 1 : normalized.length;
    if (!count || (typeof normalized === 'string' ? !normalized : normalized.some(text => !text))) throw new Error('INVALID_EMBEDDING_INPUT');
    const result = await this.provider.embed({ ...this.request, input: normalized, space: LEGACY_MEMORY_SPACE });
    this.fresh(); const space = embeddingSpaceSchema.parse(result.space);
    if (space.id !== LEGACY_MEMORY_SPACE.id || space.model !== LEGACY_MEMORY_SPACE.model || space.dimensions !== 768
      || result.vectors.length !== count || result.vectors.some(vector => !Array.isArray(vector) || vector.length !== 768
        || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)))
      || !Number.isSafeInteger(result.usage.inputTokens) || result.usage.inputTokens < 0) throw new Error('INVALID_MEMORY_EMBEDDING');
    return structuredClone(result);
  }
  embedMany(input: readonly string[]) { return this.requestVectors(input); }
  async embedOne(text: string, queryOwner?: string): Promise<Single> {
    this.fresh(); const input = text.trim(), scope = queries.getStore();
    const work = async (): Promise<Single> => {
      const result = await this.requestVectors(input);
      return { vector: result.vectors[0]!, space: result.space, usage: result.usage, reused: false };
    };
    if (!queryOwner || scope?.owner !== queryOwner) return work();
    const key = JSON.stringify([queryOwner, LEGACY_MEMORY_SPACE.id, input]);
    let pending = scope.entries.get(key); const reused = pending !== undefined;
    if (!pending) {
      if (scope.entries.size >= 32) scope.entries.delete(scope.entries.keys().next().value!);
      pending = work().catch(error => { if (scope.entries.get(key) === pending) scope.entries.delete(key); throw error; });
      scope.entries.set(key, pending);
    }
    const result = await pending; this.fresh(); return { ...structuredClone(result), reused };
  }
}
