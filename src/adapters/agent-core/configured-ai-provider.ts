import { OpenRouterProvider, type OpenRouterRoute } from '@templelabs/ai';
import { MODEL_CONFIG, getOpenRouterApiKey, type LegacyOpenRouterConfiguration, type LegacyStrictOpenRouterConfiguration, type LegacyBackgroundOpenRouterConfiguration } from '../../agent/providers/client.js';

export interface ConfiguredAIProviderOptions {
  readonly apiKey?: string;
  readonly config?: LegacyOpenRouterConfiguration;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}
function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
/** Snapshot the current native-tool route configuration without activating a production engine. */
export function createConfiguredAIProvider(options: ConfiguredAIProviderOptions = {}): OpenRouterProvider {
  const config = options.config ?? MODEL_CONFIG.openrouter;
  const env = options.env ?? process.env;
  const routes: OpenRouterRoute[] = [
    { id: 'primary', model: config.primary, providers: config.primaryProviders,
      timeoutMs: positive(env.OPENROUTER_PRIMARY_TIMEOUT_MS, 6000), temperature: 0,
      reasoning: { effort: env.OPENROUTER_PRIMARY_REASONING_EFFORT || 'medium', exclude: true } },
    { id: 'secondary', model: config.secondary, providers: config.secondaryProviders,
      timeoutMs: positive(env.OPENROUTER_SECONDARY_TIMEOUT_MS, 3500), temperature: 0,
      reasoning: { effort: env.OPENROUTER_SECONDARY_REASONING_EFFORT || 'low', exclude: true } },
    { id: 'last_resort', model: config.lastResort, providers: config.lastResortProviders,
      timeoutMs: positive(env.OPENROUTER_LAST_RESORT_TIMEOUT_MS, 3500), temperature: 0, minOutputTokens: 2800 },
  ];
  return new OpenRouterProvider({ apiKey: options.apiKey ?? getOpenRouterApiKey() ?? '', routes,
    ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}) });
}

export interface ConfiguredStructuredAIProviderOptions extends Omit<ConfiguredAIProviderOptions, 'config'> {
  readonly config?: LegacyStrictOpenRouterConfiguration;
}
/** Current strict foreground routes remain separate from the native-tool route policy. */
export function createConfiguredStructuredAIProvider(options: ConfiguredStructuredAIProviderOptions = {}): OpenRouterProvider {
  const config = options.config ?? MODEL_CONFIG.openrouter;
  const env = options.env ?? process.env;
  const routes: OpenRouterRoute[] = [
    { id: 'primary', model: config.primary, providers: config.primaryProviders, structuredOutput: true,
      timeoutMs: positive(env.OPENROUTER_PRIMARY_TIMEOUT_MS, 6000), temperature: 0,
      reasoning: { effort: env.OPENROUTER_PRIMARY_REASONING_EFFORT || 'medium', exclude: true } },
    { id: 'secondary', model: config.strictSecondary, providers: config.strictSecondaryProviders, structuredOutput: true,
      timeoutMs: positive(env.OPENROUTER_SECONDARY_TIMEOUT_MS, 3500), temperature: 0,
      reasoning: { effort: env.OPENROUTER_STRICT_SECONDARY_REASONING_EFFORT || 'medium', exclude: true } },
    { id: 'last_resort', model: config.strictLastResort, providers: config.strictLastResortProviders, structuredOutput: true,
      timeoutMs: positive(env.OPENROUTER_STRICT_FALLBACK_TIMEOUT_MS, 3500), temperature: 0,
      reasoning: { effort: env.OPENROUTER_STRICT_FALLBACK_REASONING_EFFORT || 'low', exclude: true } },
  ];
  return new OpenRouterProvider({ apiKey: options.apiKey ?? getOpenRouterApiKey() ?? '', routes,
    ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}) });
}

export type BackgroundPurpose = 'policy_compilation' | 'memory_admission' | 'next_best_action' | 'memory';
export interface ConfiguredBackgroundAIProviderOptions extends Omit<ConfiguredAIProviderOptions, 'config'> {
  readonly config?: LegacyBackgroundOpenRouterConfiguration;
}
/** Purpose-specific limits mirror the existing optional-advice and memory route policies. */
export function createConfiguredBackgroundAIProvider(purpose: BackgroundPurpose, options: ConfiguredBackgroundAIProviderOptions = {}): OpenRouterProvider {
  const config = options.config ?? MODEL_CONFIG.openrouter, env = options.env ?? process.env;
  let routes: OpenRouterRoute[];
  if (purpose === 'memory') routes = [
    { id: 'memory_primary', model: config.memoryPrimary, providers: config.memoryPrimaryProviders,
      timeoutMs: positive(env.OPENROUTER_MEMORY_PRIMARY_TIMEOUT_MS, 9000), temperature: 0,
      reasoning: { effort: env.OPENROUTER_MEMORY_PRIMARY_REASONING_EFFORT || 'low', exclude: true } },
    { id: 'memory_secondary', model: config.memorySecondary, providers: config.memorySecondaryProviders,
      timeoutMs: positive(env.OPENROUTER_MEMORY_SECONDARY_TIMEOUT_MS, 15000), temperature: 0,
      reasoning: { effort: env.OPENROUTER_SECONDARY_REASONING_EFFORT || 'minimal', exclude: true } },
    { id: 'memory_last_resort', model: config.lastResort, providers: config.lastResortProviders,
      timeoutMs: positive(env.OPENROUTER_LAST_RESORT_TIMEOUT_MS, 20000), temperature: 0 },
  ];
  else {
    if (!['policy_compilation', 'memory_admission', 'next_best_action'].includes(purpose)) throw new Error('INVALID_BACKGROUND_PURPOSE');
    const advice = purpose === 'next_best_action', cap = advice ? 2000 : 3000;
    routes = [
      { id: 'primary', model: config.primary, providers: config.primaryProviders, structuredOutput: true,
        timeoutMs: Math.min(positive(env.OPENROUTER_PRIMARY_TIMEOUT_MS, 6000), cap), temperature: 0,
        reasoning: { effort: 'low', exclude: true } },
      ...(!advice ? [{ id: 'secondary', model: config.strictSecondary, providers: config.strictSecondaryProviders, structuredOutput: true,
        timeoutMs: Math.min(positive(env.OPENROUTER_SECONDARY_TIMEOUT_MS, 3500), cap), temperature: 0,
        reasoning: { effort: 'low', exclude: true } }] : []),
    ];
  }
  return new OpenRouterProvider({ apiKey: options.apiKey ?? getOpenRouterApiKey() ?? '', routes,
    ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}) });
}

/** Explicit route declarations; native PDF capability must be evaluated before activation. */
export function createConfiguredMediaAIProvider(options: Omit<ConfiguredAIProviderOptions, 'config'> = {}): OpenRouterProvider {
  const env = options.env ?? process.env;
  const routes: OpenRouterRoute[] = [
    { id: 'vision', model: env.OPENROUTER_VISION_MODEL || 'z-ai/glm-5.3-flash', providers: [env.OPENROUTER_VISION_PROVIDER || 'baseten/fp8'],
      media: ['image'], timeoutMs: positive(env.OPENROUTER_VISION_TIMEOUT_MS, 15000), temperature: 0, maxOutputTokens: 800,
      reasoning: { effort: 'minimal', exclude: true } },
    { id: 'document', model: env.OPENROUTER_DOCUMENT_MODEL || 'google/gemini-2.5-flash-lite',
      providers: (env.OPENROUTER_DOCUMENT_PROVIDERS || 'google').split(',').map(value => value.trim()).filter(Boolean),
      media: ['image', 'pdf'], timeoutMs: positive(env.OPENROUTER_DOCUMENT_TIMEOUT_MS, 20000), temperature: 0, maxOutputTokens: 700 },
  ];
  return new OpenRouterProvider({ apiKey: options.apiKey ?? getOpenRouterApiKey() ?? '', routes,
    ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}) });
}

/** Preserve synthesis's native model choices without the tool-only fallback minimum. */
export function createConfiguredSynthesisAIProvider(options: ConfiguredAIProviderOptions = {}): OpenRouterProvider {
  const config = options.config ?? MODEL_CONFIG.openrouter, env = options.env ?? process.env;
  const routes: OpenRouterRoute[] = [
    { id: 'primary', model: config.primary, providers: config.primaryProviders,
      timeoutMs: positive(env.OPENROUTER_PRIMARY_TIMEOUT_MS, 6000), reasoning: { effort: 'low', exclude: true }, temperature: 0.2, maxOutputTokens: 180 },
    { id: 'secondary', model: config.secondary, providers: config.secondaryProviders,
      timeoutMs: positive(env.OPENROUTER_SECONDARY_TIMEOUT_MS, 3500), reasoning: { effort: 'low', exclude: true }, temperature: 0.2, maxOutputTokens: 180 },
    { id: 'last_resort', model: config.lastResort, providers: config.lastResortProviders,
      timeoutMs: positive(env.OPENROUTER_LAST_RESORT_TIMEOUT_MS, 3500), temperature: 0.2, maxOutputTokens: 180 },
  ];
  return new OpenRouterProvider({ apiKey: options.apiKey ?? getOpenRouterApiKey() ?? '', routes,
    ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}) });
}
