export interface GatewayResponseFormat extends Record<string, unknown> { type?: string }
export interface GatewayRequestOptions {
  temperature?: number | undefined; max_tokens?: number; responseFormat?: GatewayResponseFormat | null;
  tools?: readonly unknown[] | null; toolChoice?: unknown; parallelToolCalls?: boolean | undefined;
  reasoning?: unknown; providers?: readonly string[] | null; allowProviderFallbacks?: boolean;
}
export interface GatewayRequestPayload {
  model: string; messages: readonly unknown[]; temperature: number | undefined; max_tokens: number;
  stream?: false; response_format?: GatewayResponseFormat; tools?: readonly unknown[];
  tool_choice?: unknown; parallel_tool_calls?: boolean; reasoning?: unknown;
  provider?: { order: readonly string[]; only: readonly string[]; allow_fallbacks: boolean; require_parameters: true };
}

/** Pure final OpenRouter wire construction. No credentials, transport or clocks. */
export function buildRequestPayload(messages: readonly unknown[], model: string, options: GatewayRequestOptions = {}): GatewayRequestPayload {
  const { max_tokens = 800, responseFormat = null, tools = null,
    toolChoice = 'auto', parallelToolCalls, reasoning = null, providers = null,
    allowProviderFallbacks = false } = options;
  // Explicit undefined means unsupported; unlike an absent option, omit it.
  const temperature = Object.hasOwn(options, 'temperature') ? options.temperature : 0;
  const payload: GatewayRequestPayload = { model, messages, temperature, max_tokens };
  if (responseFormat?.type === 'json_schema') payload.stream = false;
  if (responseFormat) payload.response_format = responseFormat;
  if (tools?.length) {
    payload.tools = tools;
    payload.tool_choice = toolChoice;
    if (typeof parallelToolCalls === 'boolean') payload.parallel_tool_calls = parallelToolCalls;
  }
  if (reasoning) payload.reasoning = reasoning;
  if (providers?.length) {
    payload.provider = { order: providers, only: providers,
      allow_fallbacks: allowProviderFallbacks, require_parameters: true };
  }
  return payload;
}
