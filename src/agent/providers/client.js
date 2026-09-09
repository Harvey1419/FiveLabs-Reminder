/**
 * Production AI gateway.
 *
 * Foreground routing is explicit and latency-bounded:
 *   1. GPT-OSS 120B on Groq
 *   2. GLM 5.3 Flash on Baseten FP8
 *   3. Qwen 3.7 Flash on Alibaba
 *
 * OpenRouter implicit provider fallbacks are disabled. Hermes owns the route,
 * validates the canonical execute_turn boundary, and never returns to a provider
 * that already failed during the same foreground turn.
 */

function parseProviderList(value, defaults) {
  const configured = value
    ?.split(',')
    .map((provider) => provider.trim())
    .filter(Boolean);
  return configured?.length ? configured : defaults;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const fallbackModelAlias = process.env.OPENROUTER_FALLBACK_MODEL;
const fallbackProvidersAlias = process.env.OPENROUTER_FALLBACK_PROVIDERS;

export const MODEL_CONFIG = Object.freeze({
  openrouter: Object.freeze({
    primary: process.env.OPENROUTER_PRIMARY_MODEL || 'openai/gpt-oss-120b',
    primaryProviders: Object.freeze(parseProviderList(process.env.OPENROUTER_PRIMARY_PROVIDERS, ['groq'])),
    secondary: process.env.OPENROUTER_SECONDARY_MODEL || 'z-ai/glm-5.3-flash',
    secondaryProviders: Object.freeze(parseProviderList(process.env.OPENROUTER_SECONDARY_PROVIDERS, ['baseten/fp8'])),
    lastResort: process.env.OPENROUTER_LAST_RESORT_MODEL || fallbackModelAlias || 'qwen/qwen3.7-flash',
    lastResortProviders: Object.freeze(parseProviderList(
      process.env.OPENROUTER_LAST_RESORT_PROVIDERS || fallbackProvidersAlias,
      ['alibaba'],
    )),
    memoryPrimary: process.env.OPENROUTER_MEMORY_PRIMARY_MODEL || 'openai/gpt-oss-120b',
    memoryPrimaryProviders: Object.freeze(parseProviderList(process.env.OPENROUTER_MEMORY_PRIMARY_PROVIDERS, ['groq'])),
    memorySecondary: process.env.OPENROUTER_MEMORY_SECONDARY_MODEL || 'z-ai/glm-5.3-flash',
    memorySecondaryProviders: Object.freeze(parseProviderList(process.env.OPENROUTER_MEMORY_SECONDARY_PROVIDERS, ['baseten/fp8'])),
  }),
});

export function getOpenRouterApiKey() {
  return process.env.OPENROUTER_API_KEY?.replace(/"/g, '').trim()
    || (process.env.AI_API_KEY?.startsWith('sk-or-') ? process.env.AI_API_KEY.trim() : null);
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function cleanModelText(value) {
  return String(value || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
}

function classifyHttpFailure(status) {
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 504) return 'upstream_timeout';
  if (status === 401 || status === 403) return 'authentication_or_permission';
  if (status >= 500) return 'upstream_unavailable';
  return `http_${status}`;
}

function classifyThrownFailure(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || /timed?\s*out/i.test(error?.message || '')) {
    return 'timeout';
  }
  return 'network_error';
}

function compactErrorBody(rawBody, { includeProviderDetails = false, apiKey = null } = {}) {
  if (!rawBody) return '';
  let message = rawBody;
  try {
    const parsed = JSON.parse(rawBody);
    message = parsed?.error?.message || parsed?.message || rawBody;
    if (includeProviderDetails) {
      // OpenRouter's generic wrapper can hide the actual strict-schema rejection.
      // Read only diagnostic fields, never dump headers, requests or failed_generation.
      const metadata = parsed?.error?.metadata;
      let providerBody = metadata?.raw;
      if (typeof providerBody === 'string') {
        try { providerBody = JSON.parse(providerBody); }
        catch { providerBody = { message: providerBody }; }
      }
      const providerError = providerBody?.error || providerBody;
      const details = {};
      for (const [key, value] of Object.entries({
        provider: metadata?.provider_name,
        type: providerError?.type ?? metadata?.error_type ?? parsed?.error?.type,
        code: providerError?.code ?? metadata?.provider_code ?? parsed?.error?.code,
        param: providerError?.param ?? parsed?.error?.param,
        message: providerError?.message ?? parsed?.error?.message ?? parsed?.message,
      })) {
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        const text = String(value);
        details[key] = (apiKey ? text.split(apiKey).join('[REDACTED]') : text)
          .slice(0, key === 'message' ? 800 : 160);
      }
      message = Object.keys(details).length
        ? JSON.stringify(details)
        : 'Provider returned an unrecognized error envelope.';
    }
  } catch {
    // Non-JSON HTTP failures retain the existing bounded plain-text diagnostic.
  }
  const text = includeProviderDetails && apiKey
    ? String(message).split(apiKey).join('[REDACTED]')
    : String(message);
  return text.replace(/\s+/g, ' ').slice(0, includeProviderDetails ? 1600 : 240);
}

function compactProviderFinishDetail(choice, data) {
  const detail = choice?.error?.message
    || choice?.error
    || data?.error?.message
    || data?.error
    || choice?.native_finish_reason
    || '';
  if (!detail) return '';
  return String(typeof detail === 'string' ? detail : JSON.stringify(detail))
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

function buildUnavailableResponse(returnMessage) {
  const unavailable = {
    type: 'chat',
    tool: null,
    params: {},
    intent: 'chat',
    reply: 'Tuve una pequeña intermitencia de conexión con el proveedor de IA. Por favor, envíame tu mensaje de nuevo.',
  };
  return returnMessage
    ? { role: 'assistant', content: unavailable.reply, tool_calls: [], unavailable: true }
    : JSON.stringify(unavailable);
}

function createForegroundProfiles() {
  const config = MODEL_CONFIG.openrouter;
  return [
    {
      stage: 'primary',
      model: config.primary,
      providers: config.primaryProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_PRIMARY_TIMEOUT_MS, 9000),
      reasoning: {
        effort: process.env.OPENROUTER_PRIMARY_REASONING_EFFORT || 'medium',
        exclude: true,
      },
      parallelToolCalls: undefined,
      // Keep one retry only for a malformed/empty structured response. Provider
      // finish errors skip immediately to the independent fallback below.
      emptyContentRetries: 1,
    },
    {
      stage: 'secondary',
      model: config.secondary,
      providers: config.secondaryProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_SECONDARY_TIMEOUT_MS, 15000),
      reasoning: {
        effort: process.env.OPENROUTER_SECONDARY_REASONING_EFFORT || 'low',
        exclude: true,
      },
      parallelToolCalls: undefined,
      // Baseten currently rejects tool_choice=required for this endpoint. We
      // send auto but still reject any prose-only response at the Hermes boundary.
      requiredToolChoiceSupported: false,
    },
    {
      stage: 'last_resort',
      model: config.lastResort,
      providers: config.lastResortProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_LAST_RESORT_TIMEOUT_MS, 20000),
      reasoning: null,
      parallelToolCalls: undefined,
      requiredToolChoiceSupported: false,
      minCompletionTokens: 2800,
    },
  ];
}

function createBackgroundProfiles() {
  const config = MODEL_CONFIG.openrouter;
  return [
    {
      stage: 'memory_primary',
      model: config.memoryPrimary,
      providers: config.memoryPrimaryProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_MEMORY_PRIMARY_TIMEOUT_MS, 9000),
      reasoning: {
        effort: process.env.OPENROUTER_MEMORY_PRIMARY_REASONING_EFFORT || 'low',
        exclude: true,
      },
    },
    {
      stage: 'memory_secondary',
      model: config.memorySecondary,
      providers: config.memorySecondaryProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_MEMORY_SECONDARY_TIMEOUT_MS, 15000),
      reasoning: {
        effort: process.env.OPENROUTER_SECONDARY_REASONING_EFFORT || 'minimal',
        exclude: true,
      },
    },
    {
      stage: 'memory_last_resort',
      model: config.lastResort,
      providers: config.lastResortProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_LAST_RESORT_TIMEOUT_MS, 20000),
      reasoning: null,
    },
  ];
}

async function callOpenRouterAttempt(messages, model, apiKey, {
  temperature = 0,
  max_tokens = 800,
  timeoutMs = 15000,
  providers = null,
  allowProviderFallbacks = false,
  responseFormat = null,
  tools = null,
  toolChoice = 'auto',
  parallelToolCalls,
  reasoning = null,
  returnMessage = false,
  logPrefix = '[ai-client]',
  purpose = 'unspecified',
  stage = 'direct',
} = {}) {
  const startMs = Date.now();
  const requestedProviders = providers?.length ? providers : [];

  try {
    const payload = { model, messages, temperature, max_tokens };
    if (responseFormat) payload.response_format = responseFormat;
    if (tools?.length) {
      payload.tools = tools;
      payload.tool_choice = toolChoice;
      if (typeof parallelToolCalls === 'boolean') payload.parallel_tool_calls = parallelToolCalls;
    }
    if (reasoning) payload.reasoning = reasoning;

    if (requestedProviders.length) {
      payload.provider = {
        order: requestedProviders,
        only: requestedProviders,
        allow_fallbacks: allowProviderFallbacks,
        require_parameters: true,
      };
    }

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://fivelabs.co',
        'X-Title': 'Hermes Assistant',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const rawBody = await res.text().catch(() => '');
      const reason = classifyHttpFailure(res.status);
      if (logPrefix) {
        const detail = compactErrorBody(rawBody, {
          includeProviderDetails: purpose === 'initial' && responseFormat?.type === 'json_schema',
          apiKey,
        });
        console.warn(`${logPrefix} attempt purpose=${purpose} stage=${stage} model=${model} provider=${requestedProviders.join(',') || 'default'} outcome=failed reason=${reason} status=${res.status} latencyMs=${Date.now() - startMs} detail="${detail}"`);
      }
      return { ok: false, reason, status: res.status };
    }

    const data = await res.json();
    const choice = data.choices?.[0] || {};
    const responseMessage = choice.message || {};
    // Strict JSON is protocol data: prose cleanup would mutate string values
    // or turn an invalid envelope into an apparently valid decision.
    const text = extractTextContent(responseMessage.content);
    const raw = responseFormat?.type === 'json_schema' ? text.trim() : cleanModelText(text);
    const toolCalls = Array.isArray(responseMessage.tool_calls) ? responseMessage.tool_calls : [];
    const finishReason = choice.finish_reason || null;
    const actualProvider = data.provider || requestedProviders[0] || 'default';
    const usage = data.usage || {};

    if (finishReason === 'error') {
      const detail = compactProviderFinishDetail(choice, data);
      if (logPrefix) {
        console.warn(`${logPrefix} attempt purpose=${purpose} stage=${stage} model=${model} provider=${actualProvider} outcome=failed reason=provider_finish_error latencyMs=${Date.now() - startMs}${detail ? ` detail="${detail}"` : ''}`);
      }
      return { ok: false, reason: 'provider_finish_error', finishReason };
    }

    if (tools?.length && toolChoice === 'required' && toolCalls.length === 0) {
      if (logPrefix) console.warn(`${logPrefix} attempt purpose=${purpose} stage=${stage} model=${model} provider=${actualProvider} outcome=failed reason=required_tool_missing finishReason=${finishReason || 'unknown'} latencyMs=${Date.now() - startMs}`);
      return { ok: false, reason: 'required_tool_missing', finishReason };
    }

    if (!raw && toolCalls.length === 0) {
      const reason = finishReason === 'length' ? 'empty_length' : 'empty_content';
      if (logPrefix) console.warn(`${logPrefix} attempt purpose=${purpose} stage=${stage} model=${model} provider=${actualProvider} outcome=failed reason=${reason} finishReason=${finishReason || 'unknown'} latencyMs=${Date.now() - startMs}`);
      return { ok: false, reason, finishReason };
    }

    if (logPrefix) {
      console.log(`${logPrefix} attempt purpose=${purpose} stage=${stage} model=${model} provider=${actualProvider} outcome=success finishReason=${finishReason || 'unknown'} toolCalls=${toolCalls.length} promptTokens=${usage.prompt_tokens ?? 'unknown'} completionTokens=${usage.completion_tokens ?? 'unknown'} latencyMs=${Date.now() - startMs}`);
    }

    if (returnMessage) {
      return {
        ok: true,
        value: {
          role: 'assistant',
          content: raw,
          tool_calls: toolCalls,
          finishReason,
          model,
          provider: actualProvider,
          routeStage: stage,
        },
      };
    }
    return { ok: true, value: raw };
  } catch (error) {
    const reason = classifyThrownFailure(error);
    if (logPrefix) console.warn(`${logPrefix} attempt purpose=${purpose} stage=${stage} model=${model} provider=${requestedProviders.join(',') || 'default'} outcome=failed reason=${reason} latencyMs=${Date.now() - startMs} detail="${String(error?.message || error).slice(0, 180)}"`);
    return { ok: false, reason };
  }
}

function requiredDecisionMissing(attempt, { requestedToolChoice, tools, returnMessage }) {
  if (requestedToolChoice !== 'required' || !tools?.length || !attempt?.ok || !returnMessage) return false;
  const toolCalls = attempt.value?.tool_calls;
  return !Array.isArray(toolCalls) || toolCalls.length === 0;
}

async function runOpenRouterChain(messages, profiles, {
  apiKey,
  purpose,
  temperature,
  maxTokens,
  responseFormat,
  tools,
  toolChoice,
  returnMessage,
  logPrefix,
}) {
  let previousFailure = 'initial_request';

  for (const profile of profiles) {
    if (logPrefix && previousFailure !== 'initial_request') {
      console.log(`${logPrefix} route purpose=${purpose} stage=${profile.stage} model=${profile.model} provider=${profile.providers.join(',')} trigger=${previousFailure}`);
    }

    const hasRequiredNamedTool = toolChoice === 'required'
      && profile.requiredToolName
      && tools?.some((item) => item?.function?.name === profile.requiredToolName);
    const effectiveToolChoice = hasRequiredNamedTool
      ? { type: 'function', function: { name: profile.requiredToolName } }
      : toolChoice === 'required' && profile.requiredToolChoiceSupported === false
        ? 'auto'
        : toolChoice;
    let attempt;
    const maxAttempts = 1 + (profile.emptyContentRetries || 0);

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      attempt = await callOpenRouterAttempt(messages, profile.model, apiKey, {
        temperature,
        max_tokens: tools?.length ? Math.max(maxTokens, profile.minCompletionTokens || 0) : maxTokens,
        timeoutMs: profile.timeoutMs,
        providers: profile.providers,
        allowProviderFallbacks: false,
        responseFormat,
        tools,
        toolChoice: effectiveToolChoice,
        parallelToolCalls: profile.parallelToolCalls,
        reasoning: profile.reasoning,
        returnMessage,
        logPrefix,
        purpose,
        stage: profile.stage,
      });

      // Providers that only accept auto still have to return execute_turn. Prose
      // cannot terminate the chain when the caller requested a structured turn.
      if (requiredDecisionMissing(attempt, {
        requestedToolChoice: toolChoice,
        tools,
        returnMessage,
      })) {
        if (logPrefix) console.warn(`${logPrefix} attempt purpose=${purpose} stage=${profile.stage} outcome=failed reason=required_tool_missing_after_auto_fallback`);
        attempt = { ok: false, reason: 'required_tool_missing' };
      }

      // Only malformed/empty structured responses get a same-provider retry.
      // Upstream finish errors are already authoritative provider failures and
      // move immediately to an independent provider to keep foreground latency bounded.
      const retryableStructuredMiss = attempt.reason === 'empty_content'
        || attempt.reason === 'required_tool_missing';
      if (attempt.ok || !retryableStructuredMiss || attemptNumber === maxAttempts) break;
      if (logPrefix) console.warn(`${logPrefix} retry purpose=${purpose} stage=${profile.stage} reason=${attempt.reason} attempt=${attemptNumber + 1}`);
    }

    if (attempt.ok) return attempt.value;
    previousFailure = attempt.reason;
  }

  if (logPrefix) console.warn(`${logPrefix} route purpose=${purpose} exhausted reason=${previousFailure}`);
  return null;
}

export async function callChatCompletion(messages, {
  temperature = 0.0,
  max_tokens = 800,
  correlationId = null,
  tools = null,
  toolChoice = 'auto',
  returnMessage = false,
  purpose = 'initial',
  startStage = null,
  responseFormat: requestedResponseFormat = null,
} = {}) {
  const openrouterKey = getOpenRouterApiKey();
  const nativeToolMode = Array.isArray(tools);
  const logPrefix = correlationId ? `[ai-client req=${correlationId}]` : '[ai-client]';

  if (!openrouterKey) {
    console.error(`${logPrefix} OPENROUTER_API_KEY is not configured.`);
    const unavailable = {
      type: 'chat', tool: null, params: {}, intent: 'chat',
      reply: 'Error de configuración: no se encontró la clave de OpenRouter.',
    };
    return returnMessage
      ? { role: 'assistant', content: unavailable.reply, tool_calls: [], unavailable: true }
      : JSON.stringify(unavailable);
  }

  const foregroundProfiles = createForegroundProfiles();
  const requestedStartIndex = startStage
    ? foregroundProfiles.findIndex((profile) => profile.stage === startStage)
    : 0;
  const profiles = requestedStartIndex > 0
    ? foregroundProfiles.slice(requestedStartIndex)
    : foregroundProfiles;

  const result = await runOpenRouterChain(messages, profiles, {
    apiKey: openrouterKey,
    purpose,
    temperature,
    maxTokens: max_tokens,
    responseFormat: requestedResponseFormat || (nativeToolMode ? null : { type: 'json_object' }),
    tools: requestedResponseFormat ? null : tools,
    toolChoice: requestedResponseFormat ? 'none' : toolChoice,
    returnMessage,
    logPrefix,
  });

  return result || buildUnavailableResponse(returnMessage);
}

export async function callResponseSynthesis({
  facts,
  excludedClauses = [],
  language = 'es',
  correlationId = null,
} = {}) {
  const openrouterKey = getOpenRouterApiKey();
  if (!openrouterKey || !Array.isArray(facts) || facts.length === 0) return null;
  if (!Array.isArray(excludedClauses) || excludedClauses.length === 0) return null;

  const isEnglish = language === 'en';
  const areaByTool = {
    manage_reminder: 'reminders',
    manage_task: 'tasks and projects',
    manage_entity: 'projects and lists',
    manage_google_calendar: 'calendar',
    get_unified_agenda: 'personal agenda',
    manage_memory: 'personal memory',
    manage_subscription: 'Hermes subscription',
  };
  const availableAreas = [...new Set(facts.map((fact) => areaByTool[fact.tool]).filter(Boolean))];
  const messages = [
    {
      role: 'system',
      content: isEnglish
        ? `Write one tiny conversational fragment before verified assistant cards. Return JSON only: {"before":"","after":""}. Address only the excluded part. Never restate, reinterpret or claim the result of an action. Never mention internal tools or schemas. "after" must be empty. Each field is at most 160 characters.`
        : `Escribe un fragmento conversacional mínimo antes de cards verificadas del asistente. Devuelve solo JSON: {"before":"","after":""}. Atiende únicamente la parte excluida. Nunca repitas, reinterpretes ni afirmes el resultado de una acción. Nunca menciones herramientas ni esquemas internos. "after" debe quedar vacío. Cada campo admite máximo 160 caracteres.`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        availableAreas,
        excludedClauses: excludedClauses.map((item) => ({
          text: item.text || item.sourceQuote || '',
          reason: item.reason || 'out_of_scope',
        })),
      }),
    },
  ];
  const logPrefix = correlationId ? `[ai-response req=${correlationId}]` : '[ai-response]';
  const profiles = createForegroundProfiles().map((profile) => ({
    ...profile,
    reasoning: profile.reasoning ? { ...profile.reasoning, effort: 'low' } : null,
    emptyContentRetries: Math.min(profile.emptyContentRetries || 0, 1),
  }));
  const result = await runOpenRouterChain(messages, profiles, {
    apiKey: openrouterKey,
    purpose: 'response_synthesis',
    temperature: 0.2,
    maxTokens: 180,
    responseFormat: { type: 'json_object' },
    tools: null,
    toolChoice: 'none',
    returnMessage: false,
    logPrefix,
  });

  try {
    const parsed = JSON.parse(result || '{}');
    const compact = (value) => typeof value === 'string'
      ? value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
      : '';
    return { before: compact(parsed.before || parsed.after), after: '' };
  } catch {
    return null;
  }
}

export async function callOpenRouterChat(messages, model, apiKey, options = {}) {
  const attempt = await callOpenRouterAttempt(messages, model, apiKey, options);
  return attempt.ok ? attempt.value : null;
}

export async function callMemoryExtraction(messages, {
  temperature = 0.1,
  max_tokens = 600,
  timeoutMs = 9000,
} = {}) {
  const openrouterKey = getOpenRouterApiKey();
  if (!openrouterKey) {
    console.warn('[ai-memory] OPENROUTER_API_KEY is not configured.');
    return null;
  }

  const profiles = createBackgroundProfiles().map((profile) => ({
    ...profile,
    timeoutMs: profile.stage === 'memory_primary' ? timeoutMs : profile.timeoutMs,
  }));

  return runOpenRouterChain(messages, profiles, {
    apiKey: openrouterKey,
    purpose: 'memory',
    temperature,
    maxTokens: max_tokens,
    responseFormat: null,
    tools: null,
    toolChoice: 'auto',
    returnMessage: false,
    logPrefix: '[ai-memory]',
  });
}