import { domainErrorMessage } from '../../infrastructure/database/domain-persistence-client.js';
import { MEMORY_EMBEDDING_DIMENSIONS,type EmbeddingProvider } from './embedding-service.js';
export const MEMORY_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
interface EmbeddingHttpResponse { readonly ok: boolean; readonly status: number; json(): Promise<unknown>; text(): Promise<string> }
export interface EmbeddingHttpHost {
  getApiKey(): string | null;
  fetch(url: string,options: { method: string; headers: Record<string,string>; body: string; signal: AbortSignal }): Promise<EmbeddingHttpResponse>;
}
function object(value: unknown): value is Record<string,unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** The transport adapter retains the deployed model and vector(768) database contract. */
export function createOpenRouterEmbeddingProvider(host: EmbeddingHttpHost): EmbeddingProvider {
  return { model:MEMORY_EMBEDDING_MODEL,async embed(input) {
    const apiKey = host.getApiKey();
    if (!apiKey) {
      console.warn('[embeddingService] OPENROUTER_API_KEY missing, skipping vector embedding.');
      return null;
    }
    try {
      const response = await host.fetch('https://openrouter.ai/api/v1/embeddings',{
        method:'POST',headers:{ 'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`,'HTTP-Referer':'https://fivelabs.co','X-Title':'Hermes Assistant' },
        body:JSON.stringify({ model:MEMORY_EMBEDDING_MODEL,input,dimensions:MEMORY_EMBEDDING_DIMENSIONS,encoding_format:'float' }),signal:AbortSignal.timeout(6000),
      });
      if (!response.ok) {
        console.warn(`[embeddingService] OpenRouter embedding request returned ${response.status}:`,(await response.text()).slice(0,100));
        return null;
      }
      const raw = await response.json(),count = typeof input === 'string' ? 1 : input.length;
      if (!object(raw) || !Array.isArray(raw.data) || raw.data.length !== count) return null;
      const rows = raw.data.filter(object);
      if (rows.length !== count || rows.some(row => typeof row.index !== 'number' || !Number.isInteger(row.index) || row.index < 0 || row.index >= count)
        || new Set(rows.map(row => row.index)).size !== count) return null;
      rows.sort((a,b) => Number(a.index)-Number(b.index));
      const vectors: number[][] = [];
      for (const row of rows) {
        if (!Array.isArray(row.embedding) || row.embedding.length !== MEMORY_EMBEDDING_DIMENSIONS
          || !row.embedding.every((value: unknown): value is number => typeof value === 'number' && Number.isFinite(value))) {
          console.warn('[embeddingService] OpenRouter returned an invalid embedding shape.');
          return null;
        }
        vectors.push(row.embedding);
      }
      return vectors;
    } catch (error) {
      console.warn('[embeddingService] generateEmbedding failed:',domainErrorMessage(error));
      return null;
    }
  } };
}
