import { HttpTranscriptionProvider, OpenRouterEmbeddingProvider } from '@templelabs/ai';
import { getOpenRouterApiKey } from '../../agent/providers/client.js';
export const LEGACY_MEMORY_SPACE = Object.freeze({ id: 'openai/text-embedding-3-small@768:v1', model: 'openai/text-embedding-3-small', dimensions: 768 });
interface Options { readonly apiKey?: string; readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch; readonly now?: () => number }
export function createConfiguredEmbeddingProvider(options: Options = {}) {
  return new OpenRouterEmbeddingProvider({ apiKey: options.apiKey ?? getOpenRouterApiKey() ?? '', space: LEGACY_MEMORY_SPACE, timeoutMs: 6000,
    ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}) });
}
/** Select one explicit endpoint. Retry accounting/policy is separate from transcription. */
export function createConfiguredTranscriptionProvider(transport: 'groq' | 'openrouter', options: Options = {}) {
  const env = options.env ?? process.env;
  return new HttpTranscriptionProvider({ transport,
    apiKey: options.apiKey ?? (transport === 'groq' ? env.GROQ_API_KEY || (env.AI_API_KEY?.startsWith('gsk_') ? env.AI_API_KEY : '') : getOpenRouterApiKey() ?? ''),
    model: transport === 'groq' ? env.AI_AUDIO_MODEL || 'whisper-large-v3-turbo' : env.OPENROUTER_AUDIO_MODEL || 'openai/whisper-large-v3',
    timeoutMs: transport === 'groq' ? 5000 : 6000,
    ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}) });
}
