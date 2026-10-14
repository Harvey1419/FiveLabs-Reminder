export type GatewayEnvironment = Readonly<Record<string, string | undefined>>;
export interface GatewayRouteProfile {
  stage: string; model: string; providers: readonly string[]; timeoutMs: number;
  reasoning: { effort: string; exclude: boolean } | null;
  parallelToolCalls?: boolean | undefined; emptyContentRetries?: number;
  requiredToolChoiceSupported?: boolean; minCompletionTokens?: number;
  supportsStrictStructuredOutputs?: boolean; supportsTemperature?: boolean;
}
export interface GatewayRoutingDependencies { getEnvironment(): GatewayEnvironment }

/** Models/provider lists are snapshotted at initialization; keys/timeouts remain live host settings. */
export function createGatewayRouting({ getEnvironment }: GatewayRoutingDependencies) {
  const initialEnvironment = getEnvironment();
  function parseProviderList(value: string | undefined, defaults: readonly string[]): readonly string[] {
    const configured = value
      ?.split(',')
      .map((provider) => provider.trim())
      .filter(Boolean);
    return configured?.length ? configured : defaults;
  }

  function positiveNumber(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  const fallbackModelAlias = initialEnvironment.OPENROUTER_FALLBACK_MODEL;
  const fallbackProvidersAlias = initialEnvironment.OPENROUTER_FALLBACK_PROVIDERS;

  const MODEL_CONFIG = Object.freeze({
    openrouter: Object.freeze({
      primary: initialEnvironment.OPENROUTER_PRIMARY_MODEL || 'openai/gpt-oss-120b',
      primaryProviders: Object.freeze(parseProviderList(initialEnvironment.OPENROUTER_PRIMARY_PROVIDERS, ['groq'])),
      secondary: initialEnvironment.OPENROUTER_SECONDARY_MODEL || 'z-ai/glm-5.3-flash',
      secondaryProviders: Object.freeze(parseProviderList(initialEnvironment.OPENROUTER_SECONDARY_PROVIDERS, ['baseten/fp8'])),
      strictSecondary: initialEnvironment.OPENROUTER_STRICT_SECONDARY_MODEL || 'openai/gpt-oss-120b',
      strictSecondaryProviders: Object.freeze(parseProviderList(
        initialEnvironment.OPENROUTER_STRICT_SECONDARY_PROVIDERS,
        ['cerebras/fp16'],
      )),
      lastResort: initialEnvironment.OPENROUTER_LAST_RESORT_MODEL || fallbackModelAlias || 'qwen/qwen3.7-flash',
      lastResortProviders: Object.freeze(parseProviderList(
        initialEnvironment.OPENROUTER_LAST_RESORT_PROVIDERS || fallbackProvidersAlias,
        ['alibaba'],
      )),
      strictLastResort: initialEnvironment.OPENROUTER_STRICT_FALLBACK_MODEL || 'z-ai/glm-5.3-flash',
      strictLastResortProviders: Object.freeze(parseProviderList(
        initialEnvironment.OPENROUTER_STRICT_FALLBACK_PROVIDERS,
        ['baseten/fp8'],
      )),
      memoryPrimary: initialEnvironment.OPENROUTER_MEMORY_PRIMARY_MODEL || 'openai/gpt-oss-120b',
      memoryPrimaryProviders: Object.freeze(parseProviderList(initialEnvironment.OPENROUTER_MEMORY_PRIMARY_PROVIDERS, ['groq'])),
      memorySecondary: initialEnvironment.OPENROUTER_MEMORY_SECONDARY_MODEL || 'z-ai/glm-5.3-flash',
      memorySecondaryProviders: Object.freeze(parseProviderList(initialEnvironment.OPENROUTER_MEMORY_SECONDARY_PROVIDERS, ['baseten/fp8'])),
    }),
  });

  function getOpenRouterApiKey(): string | null {
    const environment = getEnvironment();
    return environment.OPENROUTER_API_KEY?.replace(/"/g, '').trim()
      || (environment.AI_API_KEY?.startsWith('sk-or-') ? environment.AI_API_KEY.trim() : null);
  }

  function createForegroundProfiles({ strictStructuredOutput = false }: { strictStructuredOutput?: boolean } = {}): GatewayRouteProfile[] {
    const config = MODEL_CONFIG.openrouter;
    const environment = getEnvironment();
    return [
      {
        stage: 'primary',
        model: config.primary,
        providers: config.primaryProviders,
        timeoutMs: positiveNumber(environment.OPENROUTER_PRIMARY_TIMEOUT_MS, 6000),
        reasoning: {
          effort: environment.OPENROUTER_PRIMARY_REASONING_EFFORT || 'medium',
          exclude: true,
        },
        parallelToolCalls: undefined,
        // Keep one retry only for a malformed/empty structured response. Provider
        // finish errors skip immediately to the independent fallback below.
        emptyContentRetries: 1,
        supportsStrictStructuredOutputs: true,
      },
      {
        stage: 'secondary',
        model: strictStructuredOutput ? config.strictSecondary : config.secondary,
        providers: strictStructuredOutput ? config.strictSecondaryProviders : config.secondaryProviders,
        timeoutMs: positiveNumber(environment.OPENROUTER_SECONDARY_TIMEOUT_MS, 3500),
        reasoning: {
          effort: strictStructuredOutput
            ? environment.OPENROUTER_STRICT_SECONDARY_REASONING_EFFORT || 'medium'
            : environment.OPENROUTER_SECONDARY_REASONING_EFFORT || 'low',
          exclude: true,
        },
        parallelToolCalls: undefined,
        // Fallback endpoints are not assumed to support tool_choice=required. We
        // send auto but still reject any prose-only response at the Hermes boundary.
        requiredToolChoiceSupported: false,
        supportsStrictStructuredOutputs: true,
      },
      {
        stage: 'last_resort',
        model: strictStructuredOutput ? config.strictLastResort : config.lastResort,
        providers: strictStructuredOutput ? config.strictLastResortProviders : config.lastResortProviders,
        timeoutMs: positiveNumber(
          strictStructuredOutput ? environment.OPENROUTER_STRICT_FALLBACK_TIMEOUT_MS : environment.OPENROUTER_LAST_RESORT_TIMEOUT_MS,
          3500,
        ),
        reasoning: strictStructuredOutput ? {
          effort: environment.OPENROUTER_STRICT_FALLBACK_REASONING_EFFORT || 'low',
          exclude: true,
        } : null,
        parallelToolCalls: undefined,
        requiredToolChoiceSupported: false,
        minCompletionTokens: 2800,
        supportsStrictStructuredOutputs: strictStructuredOutput,
        supportsTemperature: true,
      },
    ];
  }

  function createBackgroundProfiles(): GatewayRouteProfile[] {
    const config = MODEL_CONFIG.openrouter;
    const environment = getEnvironment();
    return [
      {
        stage: 'memory_primary',
        model: config.memoryPrimary,
        providers: config.memoryPrimaryProviders,
        timeoutMs: positiveNumber(environment.OPENROUTER_MEMORY_PRIMARY_TIMEOUT_MS, 9000),
        reasoning: {
          effort: environment.OPENROUTER_MEMORY_PRIMARY_REASONING_EFFORT || 'low',
          exclude: true,
        },
      },
      {
        stage: 'memory_secondary',
        model: config.memorySecondary,
        providers: config.memorySecondaryProviders,
        timeoutMs: positiveNumber(environment.OPENROUTER_MEMORY_SECONDARY_TIMEOUT_MS, 15000),
        reasoning: {
          effort: environment.OPENROUTER_SECONDARY_REASONING_EFFORT || 'minimal',
          exclude: true,
        },
      },
      {
        stage: 'memory_last_resort',
        model: config.lastResort,
        providers: config.lastResortProviders,
        timeoutMs: positiveNumber(environment.OPENROUTER_LAST_RESORT_TIMEOUT_MS, 20000),
        reasoning: null,
      },
    ];
  }

  return { MODEL_CONFIG, getOpenRouterApiKey, createForegroundProfiles, createBackgroundProfiles };
}
