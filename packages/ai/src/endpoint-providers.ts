import { audioInputSchema, embeddingSpaceSchema, transcriptionAccountingSchema, type EmbeddingSpace } from '@templelabs/contracts';
import type { TranscriptionProvider, TranscriptionRequest, TranscriptionResult, EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from './index.js';
import { EndpointError, assertEndpointFresh, boundedEndpoint } from './bounded-endpoint.js';
import { AIProviderError } from './provider-error.js';

function object(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}
function credentials(key: string, model: string, timeoutMs: number): void {
  if (!key.trim() || /[\r\n]/.test(key)) throw new EndpointError('MISSING_CREDENTIALS');
  if (!/^[\w./:-]{1,160}$/.test(model) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new EndpointError('INVALID_REQUEST');
}
interface TransportOptions { readonly apiKey: string; readonly model: string; readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch; readonly now?: () => number }

/** Audio billing has its own units; absent accounting is never fabricated as zero token usage. */
export class HttpTranscriptionProvider implements TranscriptionProvider {
  readonly #apiKey: string; private readonly options: Omit<TransportOptions, 'apiKey' | 'fetch' | 'now'> & { readonly transport: 'groq' | 'openrouter' };
  private readonly fetch: typeof globalThis.fetch; private readonly now: () => number;
  constructor(options: TransportOptions & { readonly transport: 'groq' | 'openrouter' }) {
    credentials(options.apiKey, options.model, options.timeoutMs);
    if (!['groq', 'openrouter'].includes(options.transport)) throw new EndpointError('INVALID_REQUEST');
    this.#apiKey = options.apiKey.trim(); this.options = { model: options.model, timeoutMs: options.timeoutMs, transport: options.transport };
    this.fetch = options.fetch ?? globalThis.fetch; this.now = options.now ?? Date.now;
  }
  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const deadlineMs = request.deadlineMs, signal = request.signal;
    const parsed = audioInputSchema.parse(request.audio), audio = { ...parsed, bytes: Uint8Array.from(parsed.bytes) };
    assertEndpointFresh(deadlineMs, signal, this.now);
    const mime: Record<typeof audio.format, string> = { ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', webm: 'audio/webm', aac: 'audio/aac' };
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#apiKey}` };
    let body: BodyInit;
    if (this.options.transport === 'groq') {
      const form = new FormData(); form.append('file', new Blob([audio.bytes], { type: mime[audio.format] }), `audio.${audio.format}`);
      form.append('model', this.options.model); form.append('response_format', 'json');
      if (audio.language !== 'auto') form.append('language', audio.language);
      form.append('prompt', audio.prompt ?? (audio.language === 'en' ? 'Hermes, reminder, schedule, calendar, tasks, appointments.' : 'Hermes, recordatorio, agenda, tareas, calendario, citas.'));
      body = form;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ model: this.options.model, input_audio: { data: Buffer.from(audio.bytes).toString('base64'), format: audio.format },
        ...(audio.language !== 'auto' ? { language: audio.language } : {}), temperature: 0 });
    }
    const { response, raw } = await boundedEndpoint(this.options.transport === 'groq'
      ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://openrouter.ai/api/v1/audio/transcriptions',
    { method: 'POST', headers, body }, deadlineMs, signal, this.options.timeoutMs, this.fetch, this.now);
    const data = object(raw);
    const usage = object(data?.usage);
    const parsedAccounting = usage && Object.hasOwn(usage, 'cost') ? transcriptionAccountingSchema.safeParse({ status: 'reported', costUsd: usage.cost,
      ...(usage.seconds !== undefined ? { audioSeconds: usage.seconds } : {}),
      ...(usage.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
      ...(usage.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}) }) : { success: true as const, data: { status: 'unavailable' as const } };
    if (!parsedAccounting.success) throw new EndpointError('INVALID_RESPONSE');
    const accounting = parsedAccounting.data;
    try { assertEndpointFresh(deadlineMs, signal, this.now); }
    catch (error) { if (error instanceof EndpointError) throw new EndpointError(error.code, accounting); throw error; }
    if (!response.ok || data?.error) throw new EndpointError('ENDPOINT_FAILED', accounting);
    if (typeof data?.text !== 'string' || !data.text.trim() || data.text.length > 100000) throw new EndpointError('INVALID_RESPONSE', accounting);
    return { text: data.text.trim(), accounting };
  }
}

/** No model fallback: a vector space changes with model/version even at the same dimension. */
export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpace; readonly #apiKey: string;
  private readonly timeoutMs: number; private readonly fetch: typeof globalThis.fetch; private readonly now: () => number;
  constructor(options: Omit<TransportOptions, 'model'> & { readonly space: EmbeddingSpace }) {
    this.space = Object.freeze(embeddingSpaceSchema.parse(options.space)); credentials(options.apiKey, this.space.model, options.timeoutMs);
    this.#apiKey = options.apiKey.trim(); this.timeoutMs = options.timeoutMs; this.fetch = options.fetch ?? globalThis.fetch; this.now = options.now ?? Date.now;
  }
  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const space = embeddingSpaceSchema.parse(request.space), deadlineMs = request.deadlineMs, signal = request.signal, maxInputTokens = request.maxInputTokens;
    if (space.id !== this.space.id || space.model !== this.space.model || space.dimensions !== this.space.dimensions) throw new EndpointError('INVALID_REQUEST');
    const input = (typeof request.input === 'string' ? [request.input] : [...request.input]).map(text => typeof text === 'string' ? text.trim() : '');
    if (!input.length || input.length > 128 || input.some(text => !text) || input.join('').length > 24000
      || (maxInputTokens !== undefined && (!Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1))) throw new EndpointError('INVALID_REQUEST');
    const body = JSON.stringify({ model: space.model, input: typeof request.input === 'string' ? input[0] : input, dimensions: space.dimensions, encoding_format: 'float' });
    if (maxInputTokens !== undefined && Buffer.byteLength(body) + 256 > maxInputTokens) throw new AIProviderError('GATEWAY_BUDGET');
    const { response, raw } = await boundedEndpoint('https://openrouter.ai/api/v1/embeddings', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#apiKey}` }, body }, deadlineMs, signal, this.timeoutMs, this.fetch, this.now);
    const data = object(raw), reported = object(data?.usage), prompt = reported?.prompt_tokens;
    if (typeof prompt !== 'number' || !Number.isSafeInteger(prompt) || prompt < 0) throw new AIProviderError('UNVERIFIED_USAGE', undefined, false);
    const usage = { inputTokens: prompt, outputTokens: 0 };
    if (signal.aborted) throw new AIProviderError('GATEWAY_ABORTED', usage);
    if (this.now() >= deadlineMs) throw new AIProviderError('GATEWAY_DEADLINE', usage);
    if (maxInputTokens !== undefined && prompt > maxInputTokens) throw new AIProviderError('GATEWAY_BUDGET', usage);
    const invalid = () => { throw new AIProviderError('INVALID_EMBEDDING_RESPONSE', usage); };
    if (!response.ok || data?.error || data?.model !== space.model || !Array.isArray(data.data) || data.data.length !== input.length) invalid();
    const vectors: number[][] = [], seen = new Set<number>();
    for (const entry of data!.data as unknown[]) {
      const item = object(entry), index = item?.index, vector = item?.embedding;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= input.length || seen.has(index)
        || !Array.isArray(vector) || vector.length !== space.dimensions || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) invalid();
      seen.add(index as number); vectors[index as number] = [...vector as number[]];
    }
    return { space, vectors, usage: { inputTokens: prompt } };
  }
}
