import { shouldVerifyManifest } from '../orchestration/verification-policy.js';

/**
 * Production AI gateway.
 *
 * Every text request goes through OpenRouter, while Hermes keeps explicit
 * control of both model and provider order:
 *   1. GPT-OSS 120B on Groq
 *   2. GLM 5.3 Flash on Baseten's FP8 endpoint
 *   3. Qwen 3.7 Flash on Alibaba (last resort)
 *   4. GPT-OSS/Groq recovery after alternative-provider exhaustion
 *
 * Individual attempts disable OpenRouter's implicit provider fallbacks so the
 * selected provider and every fallback reason remain observable.
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

const legacyLastResortModel = process.env.OPENROUTER_FALLBACK_MODEL;
const legacyLastResortProviders = process.env.OPENROUTER_FALLBACK_PROVIDERS;

export const MODEL_CONFIG = Object.freeze({
  openrouter: Object.freeze({
    primary: process.env.OPENROUTER_PRIMARY_MODEL || 'openai/gpt-oss-120b',
    primaryProviders: Object.freeze(parseProviderList(process.env.OPENROUTER_PRIMARY_PROVIDERS, ['groq'])),
    secondary: process.env.OPENROUTER_SECONDARY_MODEL || 'z-ai/glm-5.3-flash',
    secondaryProviders: Object.freeze(parseProviderList(process.env.OPENROUTER_SECONDARY_PROVIDERS, ['baseten/fp8'])),
    lastResort: process.env.OPENROUTER_LAST_RESORT_MODEL || legacyLastResortModel || 'qwen/qwen3.7-flash',
    lastResortProviders: Object.freeze(parseProviderList(
      process.env.OPENROUTER_LAST_RESORT_PROVIDERS || legacyLastResortProviders,
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

function compactErrorBody(rawBody) {
  if (!rawBody) return '';
  try {
    const parsed = JSON.parse(rawBody);
    const message = parsed?.error?.message || parsed?.message || rawBody;
    return String(message).replace(/\s+/g, ' ').slice(0, 240);
  } catch {
    return String(rawBody).replace(/\s+/g, ' ').slice(0, 240);
  }
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
      emptyContentRetries: 3,
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
    {
      stage: 'primary_recovery',
      model: config.primary,
      providers: config.primaryProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_PRIMARY_TIMEOUT_MS, 9000),
      reasoning: {
        effort: process.env.OPENROUTER_PRIMARY_REASONING_EFFORT || 'medium',
        exclude: true,
      },
      parallelToolCalls: undefined,
      emptyContentRetries: 1,
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
      console.log(
        `${logPrefix} route purpose=${purpose} stage=${profile.stage} model=${profile.model} provider=${profile.providers.join(',')} trigger=${previousFailure}`,
      );
    }

    const effectiveToolChoice = toolChoice === 'required' && profile.requiredToolChoiceSupported === false
      ? 'auto'
      : toolChoice;
    let attempt;
    const maxAttempts = 1 + (profile.emptyContentRetries || 0);
    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      attempt = await callOpenRouterAttempt(messages, profile.model, apiKey, {
        temperature,
        max_tokens: tools?.length
          ? Math.max(maxTokens, profile.minCompletionTokens || 0)
          : maxTokens,
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
      const retryableStructuredMiss = attempt.reason === 'empty_content'
        || attempt.reason === 'required_tool_missing'
        || (attempt.reason === 'provider_finish_error' && attemptNumber === 1);
      if (attempt.ok || !retryableStructuredMiss || attemptNumber === maxAttempts) break;
      if (logPrefix) {
        console.warn(`${logPrefix} retry purpose=${purpose} stage=${profile.stage} reason=${attempt.reason} attempt=${attemptNumber + 1}`);
      }
    }

    if (attempt.ok) return attempt.value;
    previousFailure = attempt.reason;
  }

  if (logPrefix) {
    console.warn(`${logPrefix} route purpose=${purpose} exhausted reason=${previousFailure}`);
  }
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
    responseFormat: nativeToolMode ? null : { type: 'json_object' },
    tools,
    toolChoice,
    returnMessage,
    logPrefix,
  });

  return result || buildUnavailableResponse(returnMessage);
}

export async function callResponseSynthesis({
  userText,
  facts,
  excludedClauses = [],
  language = 'es',
  correlationId = null,
} = {}) {
  const openrouterKey = getOpenRouterApiKey();
  if (!openrouterKey || !Array.isArray(facts) || facts.length === 0) return null;

  const isEnglish = language === 'en';
  const hasExcluded = Array.isArray(excludedClauses) && excludedClauses.length > 0;
  // Cards already contain backend-owned truth. Do not spend another inference
  // just to append a generic follow-up after normal successful operations.
  if (!hasExcluded) return null;

  const mode = 'address_excluded_only';
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
        ? `You write one tiny conversational fragment around verified assistant cards.
The application owns all action results and will insert the cards unchanged.
Return JSON only: {"before":"","after":""}.
- Never say or imply that an action succeeded, completed, was created, saved, scheduled, changed, or failed. Never name an action or its object.
- Never mention internal tools, schemas, validation, or evidence.
- In address_excluded_only mode: "before" politely addresses only the excluded request; "after" must be empty.
- Each field must be at most 160 characters. An empty string is valid.`
        : `Escribes un único fragmento conversacional pequeño alrededor de cards verificadas del asistente.
La aplicación es dueña de todos los resultados e insertará las cards intactas.
Devuelve solo JSON: {"before":"","after":""}.
- Nunca digas ni insinúes que una acción salió bien, terminó, fue creada, guardada, programada, modificada o falló. Nunca nombres una acción ni su objeto.
- Nunca menciones tools, schemas, validación ni evidencia interna.
- En modo address_excluded_only: "before" atiende amablemente solo la petición excluida y "after" queda vacío.
- Cada campo admite máximo 160 caracteres. Una cadena vacía es válida.`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        mode,
        availableAreas,
        excludedClauses: excludedClauses.map((item) => ({
          text: item.sourceQuote,
          reason: item.reason,
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

export async function callConversationalPresentation({
  responseText,
  language = 'es',
  correlationId = null,
} = {}) {
  const source = String(responseText || '').trim();
  if (!source) return null;

  // Primary Hermes prose is already the conversational product. By default a
  // second model is not allowed to reinterpret or rewrite it. The legacy pass
  // remains available only as an explicit rollback switch.
  if (process.env.AGENT_CONVERSATION_PRESENTATION === 'legacy') {
    const openrouterKey = getOpenRouterApiKey();
    if (!openrouterKey) return source;
    const messages = [
      {
        role: 'system',
        content: `You are the final presentation editor for a personal assistant on WhatsApp. Preserve the supplied answer exactly in meaning and return JSON only as {"opening":"","lines":[],"closing":""}.`,
      },
      { role: 'user', content: JSON.stringify({ language, verifiedResponse: source.slice(0, 700) }) },
    ];
    const result = await runOpenRouterChain(messages, createForegroundProfiles(), {
      apiKey: openrouterKey,
      purpose: 'conversation_presentation_legacy',
      temperature: 0.1,
      maxTokens: 450,
      responseFormat: { type: 'json_object' },
      tools: null,
      toolChoice: 'none',
      returnMessage: false,
      logPrefix: correlationId ? `[ai-presentation req=${correlationId}]` : null,
    });
    try {
      const parsed = JSON.parse(result || '{}');
      const opening = typeof parsed.opening === 'string' ? parsed.opening.trim() : '';
      const lines = Array.isArray(parsed.lines)
        ? parsed.lines.map((item) => `${item?.emoji ? `${item.emoji} ` : ''}${item?.text || ''}`.trim()).filter(Boolean)
        : [];
      const closing = typeof parsed.closing === 'string' ? parsed.closing.trim() : '';
      return [opening, lines.join('\n'), closing].filter(Boolean).join('\n\n') || source;
    } catch {
      return source;
    }
  }

  return source;
}

/**
 * Semantic guardrail for manifest completeness. In the new core it is a risk
 * control, not a second planner: ordinary conversation and normal operations
 * bypass the model entirely. Only sensitive/destructive manifests reach the
 * independent verifier below.
 */
export async function callManifestCoverageVerification({
  userText,
  manifest,
  conversationState = '',
  recentConversation = [],
  currentTime = '',
  assistantResponse = '',
  correlationId = null,
} = {}) {
  if (!userText || !manifest) return null;
  const operations = Array.isArray(manifest?.operations) ? manifest.operations : [];

  // Conversation / recall belongs to the primary agent. Returning the original
  // prose marks the response as trusted at the existing router boundary without
  // invoking another model or allowing a later layer to reinterpret it.
  if (operations.length === 0 && String(assistantResponse || '').trim()) {
    return {
      verdict: 'complete',
      confidence: 'high',
      manifestRequirement: 'none',
      missingQuote: '',
      feedback: '',
      assistantProposal: null,
      proposalConfidence: 'low',
      assistantClarification: null,
      clarificationConfidence: 'low',
      assistantResponseQuality: 'safe',
      responseConfidence: 'high',
      safeResponse: String(assistantResponse).trim().slice(0, 1500),
      memoryDisposition: 'extract',
    };
  }

  // Typed contract + deterministic compiler + domain validation are sufficient
  // for everyday reads and normal single-item mutations. Preserve background
  // memory eligibility; execution facts will remove operational clauses later.
  if (!shouldVerifyManifest(manifest)) {
    return {
      verdict: 'complete',
      confidence: 'high',
      manifestRequirement: operations.length > 0 ? 'operations' : 'none',
      missingQuote: '',
      feedback: '',
      assistantProposal: null,
      proposalConfidence: 'low',
      assistantClarification: null,
      clarificationConfidence: 'low',
      assistantResponseQuality: 'safe',
      responseConfidence: 'high',
      safeResponse: '',
      memoryDisposition: 'extract',
    };
  }

  const openrouterKey = getOpenRouterApiKey();
  if (!openrouterKey) return null;
  const verifierTool = {
    type: 'function',
    function: {
      name: 'verify_manifest_coverage',
      description: 'Audit a sensitive action manifest before execution.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verdict: { type: 'string', enum: ['complete', 'incomplete'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          manifestRequirement: { type: 'string', enum: ['none', 'operations', 'pending_transition'] },
          missingQuote: { type: 'string' },
          feedback: { type: 'string' },
          assistantProposalKind: { type: 'string', enum: ['none', 'reminder_cancel_elapsed', 'reminder_cancel_all', 'calendar_connect'] },
          proposalConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          assistantClarificationKind: { type: 'string', enum: ['none', 'reminder_schedule'] },
          clarificationSubject: { type: 'string' },
          missingFields: { type: 'array', items: { type: 'string', enum: ['main_time', 'advance_minutes'] }, uniqueItems: true, maxItems: 2 },
          clarificationConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          assistantResponseQuality: { type: 'string', enum: ['safe', 'replace'] },
          responseConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          safeResponse: { type: 'string' },
          memoryDisposition: { type: 'string', enum: ['extract', 'skip_operational'] },
        },
        required: [
          'verdict', 'confidence', 'manifestRequirement', 'missingQuote', 'feedback',
          'assistantProposalKind', 'proposalConfidence', 'assistantClarificationKind',
          'clarificationSubject', 'missingFields', 'clarificationConfidence',
          'assistantResponseQuality', 'responseConfidence', 'safeResponse', 'memoryDisposition',
        ],
      },
    },
  };

  const messages = [
    {
      role: 'system',
      content: `You are a safety verifier for a personal assistant. Audit only the sensitive/destructive action delta authorized by the latest user message. The verifier may block or request repair, but it may never invent a new action. Check target, scope, exclusions, confirmation semantics, pending-state references and destructive intent. Return exactly one verify_manifest_coverage tool call.`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        latestUserMessage: String(userText).slice(0, 2500),
        currentTime: String(currentTime || '').slice(0, 100),
        conversationalState: String(conversationState || '').slice(0, 2500),
        recentConversation: (Array.isArray(recentConversation) ? recentConversation : [])
          .filter((turn) => turn && ['user', 'assistant'].includes(turn.role) && typeof turn.content === 'string')
          .slice(-8)
          .map(({ role, content }) => ({ role, content: content.slice(0, 1200) })),
        proposedManifest: manifest,
        assistantResponse: String(assistantResponse || '').slice(0, 1500),
      }),
    },
  ];
  const logPrefix = correlationId ? `[ai-coverage req=${correlationId}]` : '[ai-coverage]';
  const profiles = createForegroundProfiles().map((profile) => ({
    ...profile,
    reasoning: profile.reasoning ? { ...profile.reasoning, effort: 'medium' } : null,
    emptyContentRetries: Math.min(profile.emptyContentRetries || 0, 1),
    minCompletionTokens: Math.min(profile.minCompletionTokens || 1000, 1000),
  }));
  const result = await runOpenRouterChain(messages, profiles, {
    apiKey: openrouterKey,
    purpose: 'manifest_coverage_sensitive',
    temperature: 0,
    maxTokens: 1000,
    responseFormat: null,
    tools: [verifierTool],
    toolChoice: 'required',
    returnMessage: true,
    logPrefix,
  });

  try {
    const rawArguments = result?.tool_calls?.[0]?.function?.arguments;
    const parsed = JSON.parse(rawArguments || result?.content || '{}');
    if (!['complete', 'incomplete'].includes(parsed.verdict)) return null;
    if (!['high', 'medium', 'low'].includes(parsed.confidence)) return null;
    const proposalByKind = {
      reminder_cancel_elapsed: { kind: 'reminder_cancel', scope: 'elapsed' },
      reminder_cancel_all: { kind: 'reminder_cancel', scope: 'all' },
      calendar_connect: { kind: 'calendar_connect', scope: 'google' },
    };
    const assistantProposal = proposalByKind[parsed.assistantProposalKind] || null;
    const assistantClarification = parsed.assistantClarificationKind === 'reminder_schedule'
      ? {
        kind: 'reminder_schedule',
        subject: typeof parsed.clarificationSubject === 'string'
          ? parsed.clarificationSubject.trim().slice(0, 120)
          : '',
        missingFields: (Array.isArray(parsed.missingFields) ? parsed.missingFields : [])
          .filter((field) => ['main_time', 'advance_minutes'].includes(field)),
      }
      : null;
    return {
      verdict: parsed.verdict,
      confidence: parsed.confidence,
      manifestRequirement: ['none', 'operations', 'pending_transition'].includes(parsed.manifestRequirement)
        ? parsed.manifestRequirement
        : 'operations',
      missingQuote: parsed.verdict === 'incomplete' && typeof parsed.missingQuote === 'string'
        ? parsed.missingQuote.slice(0, 500)
        : '',
      feedback: parsed.verdict === 'incomplete' && typeof parsed.feedback === 'string'
        ? parsed.feedback.slice(0, 800)
        : '',
      assistantProposal,
      proposalConfidence: assistantProposal && ['high', 'medium', 'low'].includes(parsed.proposalConfidence)
        ? parsed.proposalConfidence
        : 'low',
      assistantClarification,
      clarificationConfidence: assistantClarification && ['high', 'medium', 'low'].includes(parsed.clarificationConfidence)
        ? parsed.clarificationConfidence
        : 'low',
      assistantResponseQuality: parsed.assistantResponseQuality === 'replace' ? 'replace' : 'safe',
      responseConfidence: ['high', 'medium', 'low'].includes(parsed.responseConfidence)
        ? parsed.responseConfidence
        : 'low',
      safeResponse: typeof parsed.safeResponse === 'string' ? parsed.safeResponse.trim().slice(0, 500) : '',
      memoryDisposition: parsed.memoryDisposition === 'skip_operational'
        || assistantClarification
        || assistantProposal
        ? 'skip_operational'
        : 'extract',
    };
  } catch {
    return null;
  }
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
        console.warn(`${logPrefix} attempt purpose=${purpose} stage=${stage} model=${model} provider=${requestedProviders.join(',') || 'default'} outcome=failed reason=${reason} status=${res.status} latencyMs=${Date.now() - startMs} detail="${compactErrorBody(rawBody)}"`);
      }
      return { ok: false, reason, status: res.status };
    }

    const data = await res.json();
    const responseMessage = data.choices?.[0]?.message || {};
    const raw = cleanModelText(extractTextContent(responseMessage.content));
    const toolCalls = Array.isArray(responseMessage.tool_calls) ? responseMessage.tool_calls : [];
    const finishReason = data.choices?.[0]?.finish_reason || null;
    const actualProvider = data.provider || requestedProviders[0] || 'default';
    const usage = data.usage || {};

    if (finishReason === 'error') {
      if (logPrefix) console.warn(`${logPrefix} attempt purpose=${purpose} stage=${stage} model=${model} provider=${actualProvider} outcome=failed reason=provider_finish_error latencyMs=${Date.now() - startMs}`);
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

export async function callOpenRouterChat(messages, model, apiKey, options = {}) {
  const attempt = await callOpenRouterAttempt(messages, model, apiKey, options);
  return attempt.ok ? attempt.value : null;
}

export async function callPendingTransitionVerification({
  userText, pendingState, proposedOperation, latestAssistantMessage = '', correlationId = null,
} = {}) {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) return null;
  const verifierTool = {
    type: 'function',
    function: {
      name: 'verify_pending_transition',
      description: 'Classify the concrete effect the current reply authorizes for an unexecuted pending proposal.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          transition: { type: 'string', enum: ['execute_pending', 'discard_pending', 'revise_pending', 'unrelated_turn', 'clarification_request'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['transition', 'confidence'],
      },
    },
  };
  const messages = [
    {
      role: 'system',
      content: `You are a safety verifier for conversational state transitions. The typed proposal is currently NOT EXECUTED. Determine whether the latest reply actually addresses it. Judge meaning in context, not keywords. The immediately preceding assistant message has conversational priority. Only use execute_pending, discard_pending, or revise_pending when the reply semantically answers the pending proposal itself. Return exactly one tool call.`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        immediatelyPrecedingAssistantMessage: String(latestAssistantMessage || '').slice(0, 1500),
        pendingState,
        latestReply: userText,
        primaryProposal: proposedOperation,
      }),
    },
  ];
  const logPrefix = correlationId ? `[ai-verifier req=${correlationId}]` : '[ai-verifier]';
  const config = MODEL_CONFIG.openrouter;
  const profiles = [
    {
      stage: 'secondary_verifier', model: config.secondary, providers: config.secondaryProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_SECONDARY_TIMEOUT_MS, 15000), maxTokens: 250,
      toolChoice: 'required', reasoning: { effort: process.env.OPENROUTER_SECONDARY_REASONING_EFFORT || 'minimal', exclude: true },
    },
    {
      stage: 'last_resort_verifier', model: config.lastResort, providers: config.lastResortProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_LAST_RESORT_TIMEOUT_MS, 20000), maxTokens: 600,
      toolChoice: 'auto', reasoning: null,
    },
    {
      stage: 'primary_verifier_fallback', model: config.primary, providers: config.primaryProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_PRIMARY_TIMEOUT_MS, 15000), maxTokens: 250,
      toolChoice: 'required', reasoning: { effort: 'minimal', exclude: true },
    },
  ];

  for (const profile of profiles) {
    const attempt = await callOpenRouterAttempt(messages, profile.model, apiKey, {
      temperature: 0,
      max_tokens: profile.maxTokens,
      timeoutMs: profile.timeoutMs,
      providers: profile.providers,
      allowProviderFallbacks: false,
      tools: [verifierTool],
      toolChoice: profile.toolChoice,
      reasoning: profile.reasoning,
      returnMessage: true,
      logPrefix,
      purpose: 'pending_transition_verification',
      stage: profile.stage,
    });
    if (!attempt.ok) continue;
    const rawArguments = attempt.value?.tool_calls?.[0]?.function?.arguments;
    try {
      const parsed = JSON.parse(rawArguments || attempt.value?.content || '{}');
      if (
        ['execute_pending', 'discard_pending', 'revise_pending', 'unrelated_turn', 'clarification_request'].includes(parsed.transition)
        && ['high', 'medium', 'low'].includes(parsed.confidence)
      ) return parsed;
    } catch {
      // Next provider may still return the typed verdict.
    }
  }
  return null;
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
