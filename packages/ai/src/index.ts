import {
  aiResponseSchema, aiTranscriptSchema,
  type AIMessage, type AIResponse, type ToolSpecification, type JsonObject, type MediaAttachment,
  type AudioInput, type TranscriptionAccounting, type EmbeddingSpace,
} from '@templelabs/contracts';

export interface CompletionRequest {
  readonly messages: readonly AIMessage[];
  readonly tools: readonly ToolSpecification[];
  readonly maxOutputTokens: number;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  readonly maxInputTokens?: number;
  readonly maxTotalTokens?: number;
  /** Host-supplied rate ceiling across every configured route; not a model price lookup. */
  readonly spendLimit?: { readonly maxUsd: number; readonly inputUsdPerMillion: number; readonly outputUsdPerMillion: number };
}

export interface AIProvider {
  readonly capabilities: {
    readonly toolCalling: boolean;
    readonly structuredOutput: boolean;
  };
  forTurn?(): AIProvider;
  complete(request: CompletionRequest): Promise<AIResponse>;
}

/** Portable structured output. The host validator is pure and runs before accepting a decision. */
export interface StructuredCompletionRequest extends Omit<CompletionRequest, 'tools'> {
  readonly output: { readonly name: string; readonly schema: JsonObject };
  readonly validate: (value: JsonObject) => JsonObject;
}
export type StructuredCompletionResult = {
  readonly usage: AIResponse['usage'];
} & ({ readonly status: 'success'; readonly data: JsonObject } | { readonly status: 'refused'; readonly data: null });
export interface StructuredAIProvider extends AIProvider {
  forTurn?(): StructuredAIProvider;
  completeStructured(request: StructuredCompletionRequest): Promise<StructuredCompletionResult>;
}

/** Complete auxiliary text only; local validation is mandatory and no tool effects are available. */
export interface TextCompletionRequest extends Omit<CompletionRequest, 'tools'> {
  readonly responseFormat?: 'json_object';
  readonly validate: (text: string) => string;
}
export type TextCompletionResult = { readonly usage: AIResponse['usage'] }
  & ({ readonly status: 'success'; readonly text: string } | { readonly status: 'refused'; readonly text: null });
export interface TextAIProvider extends AIProvider {
  forTurn?(): TextAIProvider;
  completeText(request: TextCompletionRequest): Promise<TextCompletionResult>;
}
/** Binary evidence is ephemeral input, never tool authority or persisted agent history. */
export interface MediaCompletionRequest extends Omit<TextCompletionRequest, 'messages' | 'responseFormat'> {
  readonly prompt: string;
  readonly attachment: MediaAttachment;
}
export interface MediaAIProvider extends AIProvider {
  forTurn?(): MediaAIProvider;
  readonly mediaCapabilities: { readonly image: boolean; readonly pdf: boolean };
  completeMedia(request: MediaCompletionRequest): Promise<TextCompletionResult>;
}

export interface TranscriptionRequest {
  readonly audio: AudioInput; readonly deadlineMs: number; readonly signal: AbortSignal;
}
export interface TranscriptionResult { readonly text: string; readonly accounting: TranscriptionAccounting }
export interface TranscriptionProvider { transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> }
export interface EmbeddingRequest {
  readonly input: string | readonly string[]; readonly space: EmbeddingSpace;
  readonly deadlineMs: number; readonly signal: AbortSignal; readonly maxInputTokens?: number;
}
export interface EmbeddingResult {
  readonly vectors: readonly (readonly number[])[]; readonly space: EmbeddingSpace;
  readonly usage: { readonly inputTokens: number };
}
export interface EmbeddingProvider { readonly space: EmbeddingSpace; embed(request: EmbeddingRequest): Promise<EmbeddingResult> }

export type RecordedRequest = Omit<CompletionRequest, 'signal'>;
export interface MockCompletion {
  readonly response: AIResponse | Error;
  readonly inspect?: (request: RecordedRequest) => void;
}

/** Scripted engine tests, not a substitute for live semantic evaluation. */
export class MockAIProvider implements AIProvider {
  readonly capabilities = Object.freeze({ toolCalling: true, structuredOutput: true });
  private readonly sequence: MockCompletion[];
  private readonly recorded: RecordedRequest[] = [];
  private cursor = 0;

  constructor(sequence: readonly MockCompletion[], private readonly now: () => number = Date.now) {
    this.sequence = sequence.map(step => ({
      response: step.response instanceof Error ? step.response : aiResponseSchema.parse(step.response),
      ...(step.inspect ? { inspect: step.inspect } : {}),
    }));
  }

  get requests(): readonly RecordedRequest[] { return structuredClone(this.recorded); }
  get remainingSteps(): number { return this.sequence.length - this.cursor; }

  async complete(request: CompletionRequest): Promise<AIResponse> {
    request.signal.throwIfAborted();
    if (!Number.isFinite(request.deadlineMs) || this.now() >= request.deadlineMs) {
      throw new Error('Provider deadline exceeded');
    }
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) {
      throw new Error('maxOutputTokens must be a positive safe integer');
    }
    const step = this.sequence[this.cursor];
    if (!step) throw new Error('MockAIProvider sequence exhausted');
    const snapshot: RecordedRequest = {
      messages: aiTranscriptSchema.parse(request.messages),
      tools: structuredClone(request.tools),
      maxOutputTokens: request.maxOutputTokens,
      deadlineMs: request.deadlineMs,
      ...(request.maxInputTokens !== undefined ? { maxInputTokens: request.maxInputTokens } : {}),
      ...(request.maxTotalTokens !== undefined ? { maxTotalTokens: request.maxTotalTokens } : {}),
      ...(request.spendLimit ? { spendLimit: structuredClone(request.spendLimit) } : {}),
    };
    // Inspect a detached snapshot so assertions cannot mutate recorded history.
    step.inspect?.(structuredClone(snapshot));
    request.signal.throwIfAborted();
    if (this.now() >= request.deadlineMs) throw new Error('Provider deadline exceeded');
    this.recorded.push(snapshot);
    this.cursor++;
    if (step.response instanceof Error) throw step.response;
    if (step.response.usage.outputTokens > request.maxOutputTokens) {
      throw new Error('Scripted response exceeds output token budget');
    }
    return structuredClone(step.response);
  }
}

export { OpenRouterProvider, GatewayError, type OpenRouterProviderOptions, type GatewayFailureCode } from './openrouter-provider.js';
export { openRouterPayload, decodeOpenRouterResponse, reportedOpenRouterUsage, structuredOpenRouterPayload, decodeStructuredOpenRouterResponse, type OpenRouterRoute } from './openrouter-protocol.js';
export { AIProviderError } from './provider-error.js';
export { HttpTranscriptionProvider, OpenRouterEmbeddingProvider } from './endpoint-providers.js';
export { EndpointError } from './bounded-endpoint.js';
