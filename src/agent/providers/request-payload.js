/** Pure final OpenRouter wire construction. No credentials, transport or clocks. */
export function buildRequestPayload(messages, model, options = {}) {
  const { max_tokens = 800, responseFormat = null, tools = null,
    toolChoice = 'auto', parallelToolCalls, reasoning = null, providers = null,
    allowProviderFallbacks = false } = options;
  // Explicit undefined means unsupported; unlike an absent option, omit it.
  const temperature = Object.hasOwn(options, 'temperature') ? options.temperature : 0;
  const payload = { model, messages, temperature, max_tokens };
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
