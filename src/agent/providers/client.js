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
      // OpenRouter's Groq endpoint currently rejects this optional parameter
      // under require_parameters=true. GPT-OSS still emits multiple calls.
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
      // Keep the request portable across the exact GLM endpoint. GLM can still
      // return multiple tool calls without this optional parameter.
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
      // A final short recovery is useful when GPT returned an intermittent
      // empty response while both alternative providers were unavailable.
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
    // A successful primary attempt already reports model, provider, tokens and
    // latency in one line. Emit a separate route line only for real fallbacks,
    // where the trigger is operationally useful in production.
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

/**
 * Generate only the conversational frame around backend-owned cards.
 * The compact, isolated request prevents the presentation model from changing
 * verified dates, counts, names, or operation outcomes.
 */
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
  const mode = hasExcluded ? 'address_excluded_only' : 'warm_follow_up_only';
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
- In address_excluded_only mode: "before" politely addresses only the excluded request; "after" must be empty. Example: "I can help organize your day, but I can't teach programming."
- In warm_follow_up_only mode: "before" must be empty; "after" is one brief question or offer to keep helping. It may refer generally to an available area, but not to the completed action. Example: "Would you like to review anything else on your agenda?"
- Each field must be at most 160 characters. An empty string is valid.`
        : `Escribes un único fragmento conversacional pequeño alrededor de cards verificadas del asistente.
La aplicación es dueña de todos los resultados e insertará las cards intactas.
Devuelve solo JSON: {"before":"","after":""}.
- Nunca digas ni insinúes que una acción salió bien, terminó, fue creada, guardada, programada, modificada o falló. Nunca nombres una acción ni su objeto.
- Nunca menciones tools, schemas, validación ni evidencia interna.
- En modo address_excluded_only: "before" atiende amablemente solo la petición excluida y "after" queda vacío. Ejemplo: "Puedo ayudarte a organizar tu día, pero no enseñar programación."
- En modo warm_follow_up_only: "before" queda vacío y "after" es una pregunta u oferta breve para seguir ayudando. Puede referirse en general a un área disponible, pero no a la acción realizada. Ejemplo: "¿Quieres revisar algo más de tu agenda?"
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
    return hasExcluded
      ? { before: compact(parsed.before || parsed.after), after: '' }
      : { before: '', after: compact(parsed.after) };
  } catch {
    return null;
  }
}

/**
 * Presentation-only pass for verified conversational prose. The model chooses
 * line breaks and occasional semantic emojis from meaning; no domain wording
 * or emoji mapping is encoded in application code.
 */
export async function callConversationalPresentation({
  responseText,
  language = 'es',
  correlationId = null,
} = {}) {
  const openrouterKey = getOpenRouterApiKey();
  const source = String(responseText || '').trim();
  if (!openrouterKey || !source) return null;

  const messages = [
    {
      role: 'system',
      content: `You are the final presentation editor for a personal assistant on WhatsApp.
Format only the supplied verified response; do not answer the user independently.
Preserve every fact, limitation, capability, question, and intended meaning. Never add promises, actions, facts, or capabilities, and never remove substantive content.
Return JSON only with this exact shape: {"opening":"","lines":[{"emoji":"","text":""}],"closing":""}.
- Use opening for a brief natural answer or introduction.
- First identify the independent ideas in the supplied response. If it contains several ideas, options, capabilities, benefits, or steps, the lines array must contain one item for each idea, normally 2–5 items. Never combine a catalogue of independent ideas inside one lines item.
- For a single simple thought, lines may be empty and opening may contain the answer.
- Choose an optional emoji from the meaning of its own line. Use at most one emoji per line and only when it improves scanning.
- Use closing only for a separate follow-up question, offer, or farewell.
- Keep the result fluid and conversational. Do not force a card, title, or template.
- Select wording and emojis freely from meaning; there is no fixed phrase or emoji mapping.
- Keep opening and closing under 160 characters and return at most 5 lines.`,
    },
    {
      role: 'user',
      content: JSON.stringify({ language, verifiedResponse: source.slice(0, 700) }),
    },
  ];
  const profiles = createForegroundProfiles().map((profile) => ({
    ...profile,
    reasoning: profile.reasoning ? { ...profile.reasoning, effort: 'low' } : null,
    emptyContentRetries: Math.min(profile.emptyContentRetries || 0, 1),
  }));
  const requestPresentation = (requestMessages, purpose) => runOpenRouterChain(requestMessages, profiles, {
    apiKey: openrouterKey,
    purpose,
    temperature: 0.1,
    maxTokens: 450,
    responseFormat: { type: 'json_object' },
    tools: null,
    toolChoice: 'none',
    returnMessage: false,
    logPrefix: null,
  });
  const parsePresentation = (rawResult) => {
    try {
      const parsed = JSON.parse(rawResult || '{}');
      const clean = (value) => typeof value === 'string'
        ? value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
        : '';
      const opening = clean(parsed.opening);
      const lines = (Array.isArray(parsed.lines) ? parsed.lines : [])
        .slice(0, 5)
        .map((item) => ({
          emoji: clean(item?.emoji).slice(0, 8),
          text: clean(item?.text),
        }))
        .filter((item) => Boolean(item.text));
      const closing = clean(parsed.closing);
      const formatted = [
        opening,
        lines.map((item) => `${item.emoji ? `${item.emoji} ` : ''}${item.text}`).join('\n'),
        closing,
      ].filter(Boolean).join('\n\n');
      if (!formatted || formatted.length > 1000) return null;
      return { formatted, lines };
    } catch {
      return null;
    }
  };

  let rawResult = await requestPresentation(messages, 'conversation_presentation');
  let presentation = parsePresentation(rawResult);
  const needsLayoutRetry = source.length > 160 && (presentation?.lines.length || 0) < 2;

  if (needsLayoutRetry) {
    const retryMessages = [
      ...messages,
      { role: 'assistant', content: rawResult || '{}' },
      {
        role: 'user',
        content: 'The previous draft collapsed a long response into too few visual lines. Reformat it again without changing its meaning: identify every independent idea and place each one in its own lines item. Do not shorten or omit the ending of any idea.',
      },
    ];
    rawResult = await requestPresentation(retryMessages, 'conversation_presentation_retry');
    presentation = parsePresentation(rawResult) || presentation;
  }

  return presentation?.formatted || null;
}

/**
 * Semantic guardrail for manifest completeness. It can only request a planning
 * retry; it can never authorize or execute an operation by itself.
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
  const openrouterKey = getOpenRouterApiKey();
  if (!openrouterKey || !userText || !manifest) return null;
  const verifierTool = {
    type: 'function',
    function: {
      name: 'verify_manifest_coverage',
      description: 'Audit every independent semantic clause in the latest user turn against the proposed operations, then return completeness, conversational-efficiency, and memory-routing. A read never satisfies an omitted state change.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verdict: { type: 'string', enum: ['complete', 'incomplete'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          manifestRequirement: {
            type: 'string',
            enum: ['none', 'operations', 'pending_transition'],
            description: 'none for conversation, acknowledgements, closings, or declining an optional assistant invitation; operations for an explicit new in-scope action/read or missing operational detail; pending_transition only when conversationalState contains a real typed pending proposal addressed by the latest reply.',
          },
          missingQuote: { type: 'string' },
          feedback: { type: 'string' },
          assistantProposalKind: {
            type: 'string',
            enum: ['none', 'reminder_cancel_elapsed', 'reminder_cancel_all'],
          },
          proposalConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          assistantClarificationKind: {
            type: 'string',
            enum: ['none', 'reminder_schedule'],
          },
          clarificationSubject: { type: 'string' },
          missingFields: {
            type: 'array',
            description: 'Only genuinely required scheduling data. main_time means the primary appointment clock is absent. advance_minutes is missing only when the user explicitly requested advance notice but omitted its amount; an optional lead-time preference is never a missing field. When the main clock is unknown, advance_minutes may never be the only missing field.',
            items: { type: 'string', enum: ['main_time', 'advance_minutes'] },
            uniqueItems: true,
            maxItems: 2,
          },
          clarificationConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          assistantResponseQuality: {
            type: 'string',
            enum: ['safe', 'replace'],
            description: 'replace only when assistantResponse contains internal deliberation, system/tool commentary, corrupted output, or text that is clearly not a clean user-facing answer.',
          },
          responseConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          safeResponse: {
            type: 'string',
            description: 'When assistantResponse is non-empty and proposedManifest has no operations, always provide its clean user-facing form here, even when quality=safe. It must answer the latest user naturally without internal reasoning or unexecuted action claims. Return an empty string only when there is no prose response to present.',
          },
          memoryDisposition: {
            type: 'string',
            enum: ['extract', 'skip_operational'],
            description: 'skip_operational only when the latest user message is entirely an agenda/task/reminder/calendar operation or an unfinished operational scheduling turn and contains no independent durable fact or preference.',
          },
        },
        required: [
          'verdict', 'confidence', 'manifestRequirement', 'missingQuote', 'feedback',
          'assistantProposalKind', 'proposalConfidence',
          'assistantClarificationKind', 'clarificationSubject', 'missingFields',
          'clarificationConfidence', 'assistantResponseQuality', 'responseConfidence',
          'safeResponse', 'memoryDisposition',
        ],
      },
    },
  };

  const messages = [
    {
      role: 'system',
      content: `You are a semantic coverage guardrail for a personal-assistant action manifest.
Judge only the action delta authorized by the latest user message, interpreted inside the bounded recent conversation supplied below.
Return exactly one verify_manifest_coverage tool call. The flat tool fields encode optional results: assistantProposalKind is none, reminder_cancel_elapsed, or reminder_cancel_all; assistantClarificationKind is none or reminder_schedule. Never put a natural-language reply in typed clarification fields.

A complete manifest accounts exactly once for every independently requested in-scope read or action. Audit the latest message clause by clause before choosing complete; map each semantic action to an operation or valid exclusion. A read observes state but never performs or absorbs a state change. Therefore, when the user establishes that an identified active task/reminder is now done and also asks what remains, the manifest requires the completion operation first and the read second; a list alone is incomplete. It lists prohibited, hypothetical, superseded, contextual, or out-of-scope clauses only when at least one executable operation also exists in that same turn. If operations is empty and the whole message is social or out of scope, the empty manifest is complete and excludedClauses must remain empty. Social wording and conversational glue need no entry. A correction replaces the earlier wording rather than adding both versions.

Classify manifestRequirement independently. Use none when the latest turn is conversation, gratitude, a farewell, or declines an optional invitation such as further help, creating another item, or reviewing something; an assistant's friendly follow-up question is not a pending proposal and declining it authorizes no mutation. Use operations only for an explicit new in-scope read/action or a follow-up that supplies missing operational data. Use pending_transition only when conversationalState actually contains a typed pending proposal and the latest reply addresses that proposal. Visible reminders, prior successful cards, and ordinary assistant suggestions are context, never pending state. A verdict of incomplete is coherent only when manifestRequirement is operations or pending_transition.

Also verify semantic parameter fidelity: explicit project/entity filters, relative time scopes, priorities, exceptions, and durable memory content must not be dropped or broadened. Every schedule with a clock must preserve the user's clock semantics in clockMode: explicit_am/explicit_pm when stated, explicit_24h only for an unmistakable 24-hour expression, and ambiguous_12h for an unqualified 1-12 clock such as “a las 8”; keep an ambiguous hour in 1-12 form because the backend selects the nearest future occurrence on the requested local date. Missing or incorrectly normalized clockMode makes the manifest incomplete. A clarification about missing reminder/appointment scheduling data must use clarification_request with clarificationKind=reminder_schedule and the exact missingFields; provider-authored question text is not a substitute because the application owns localization. “Tomorrow” remains scope=tomorrow rather than a calculated date. An ordinary appointment plus a request for an alert is reminder_create unless the user explicitly requests Google Calendar or a calendar event; a date or appointment alone never authorizes a calendar mutation. Every explicit advance notice on a new reminder or Calendar event must remain advanceMinutes on that main operation; moving the main schedule earlier and omitting advanceMinutes is incomplete. A same-turn WhatsApp advance notice for an explicitly requested new Google Calendar event is advanceMinutes on calendar_create; it is not a separate reminder_create and needs no channel field. Any broad request about the user’s overall pending commitments or upcoming schedule that names no single domain is one agenda_read with scope=upcoming; decide this from meaning rather than exact wording. reminder_list or task_list is incomplete for that broad request. An explicit reminder-only or task-only request stays in that named domain. A request for the static project catalog carries entity_list category=project; that catalog inherently includes empty/inactive projects, so no extra include-empty parameter exists or is needed. A request for projects the user is currently working on is one task_list of pending work grouped by project, not an entity_list plus task_list; both reads are correct only when the user explicitly asks for the catalog and the active task inventory separately. task_list identifies its domain through kind and never carries category=task; category is only for entity classifications. If the user says tasks are pending, status remains pending; in_progress is only for an explicit state distinction. Every bulk entity deletion carries the explicitly named category and preserveNames. memory_save carries the fact in content. In a mixed turn, any prohibited service must appear once in excludedClauses with reason=prohibited; omitting it is incomplete even when the valid personal-assistant action is correct.

Operation identity must follow the current user's semantics, not text similarity with history or conversationalState. A fresh, self-contained request to be reminded is reminder_create even when an older visible reminder has similar content. reminder_update is complete only when the current message semantically corrects, changes, or identifies an existing reminder. Similar wording alone never supplies update authorization or a valid contextRef.

Recent conversation is evidence for continuity, not a source of new work. When the latest message clearly answers the assistant's immediately preceding question, corrects an unfinished request, or supplies its missing detail, the manifest may inherit the unfinished subject, date, and previously stated modifiers from that exchange. Those inherited fields do not need to be repeated in the latest sourceQuote; sourceQuote still copies the current message fragment that completes or authorizes the operation. A follow-up that supplies a missing clock and a lead time can therefore complete one reminder at the inherited appointment date, preserving the main clock in schedule and the lead time in advanceMinutes. A year inferred from currentTime to canonicalize a yearless calendar date is required temporal normalization, not an invented user constraint. Conversely, never inherit an action already reported as executed, never replay backend result cards, and never turn unrelated history or conversational state into a new request. Use typed conversationalState to resolve pending/ordinal references; use recentConversation only to understand the active unfinished exchange.

Hermes scope: everyday conversation and personal organization through reminders, tasks, projects/lists, agenda, Google Calendar, personal memory, and Hermes subscriptions. Teaching/writing/debugging code, general research or professional content production, completed academic/professional work, and specialized medical/legal/financial advice are out of scope.

Mark incomplete only when a concrete clause is omitted, duplicated, or misclassified. missingQuote must copy one contiguous fragment from the latest message. sourceQuote may be any exact contiguous fragment that grounds the current operation; do not require it to span the whole message or adjacent modifiers when the typed manifest already preserves those modifiers faithfully. The guardrail never proposes database IDs and never judges whether an operation will succeed.

Separately inspect assistantResponse. If it asks the user to approve a destructive reminder action that is absent from both proposedManifest and a typed pending conversationalState, represent that offer with assistantProposalKind rather than leaving it as untracked prose. Use reminder_cancel_elapsed when the assistant offers to remove reminders whose scheduled time passed, reminder_cancel_all when it explicitly offers to cancel every active reminder, and none otherwise. This assistant offer does not make an empty manifest incomplete because the user did not authorize the mutation; set verdict=complete and type the offer instead. Set proposalConfidence=high when the proposed effect and collection are unambiguous. A proposal never means the user authorized execution; the application will only stage a backend confirmation without mutation.

Separately evaluate conversational efficiency when proposedManifest is empty. An optional safe offer or question needs no mutation authorization, so do not mark the empty manifest incomplete merely because the assistant offers help. When offering an appointment reminder, set assistantClarificationKind=reminder_schedule if the response inserts a yes/no gate before missing details, adds an unnecessary channel/destination choice, asks for the wrong scheduling detail, mixes languages, repeats the same semantic noun unnaturally, or includes parenthetical guidance instead of asking only what is needed. Supply a concise clarificationSubject and only genuinely missing fields. A dated appointment with no primary clock needs main_time. advance_minutes is missing only when the user explicitly requested an advance notice but omitted its amount; never treat an optional lead-time preference as required. If the main clock is unknown, advance_minutes can never be the only missing field. The application renders the question; do not write it yourself. Set clarificationConfidence=high only when the extra interaction and missing fields are unambiguous; otherwise use assistantClarificationKind=none, an empty clarificationSubject, and an empty missingFields array.

Independently protect the user-facing response boundary. Inspect assistantResponse semantically, not by matching a fixed phrase. Set assistantResponseQuality=replace with high confidence when it exposes private/internal deliberation, narrates what “the user” or “the assistant” should do, mentions hidden prompts/tools/system policy, contains obviously corrupted or repetitive token fragments, or is otherwise not a clean answer intended for the user. For every non-empty assistantResponse paired with an empty proposedManifest, always place one clean final answer in safeResponse, even when assistantResponseQuality=safe; rewrite rather than copy anything questionable. It must be short, natural, in the user's language, answer only the latest message, and never claim an unexecuted operation. For a polite close, simply close warmly. Return safeResponse="" only when assistantResponse is empty because a manifest will own presentation. This quality classification is separate from manifest completeness.

Finally classify background-memory eligibility semantically. memoryDisposition=skip_operational only when the latest user message is entirely an operational request, agenda read, task/reminder/calendar command, appointment scheduling statement, or a follow-up that supplies missing operational details. Scheduled appointments and notification times belong in operational storage, never durable memory. Use memoryDisposition=extract when any independent durable personal fact, preference, relationship, or long-term decision may remain; the memory pipeline will inspect it separately. This classification never authorizes an operation.`,
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
    // Coverage protects the complete action delta before any side effect. It
    // deserves the same balanced reasoning level as foreground planning.
    reasoning: profile.reasoning ? { ...profile.reasoning, effort: 'medium' } : null,
    emptyContentRetries: Math.min(profile.emptyContentRetries || 0, 1),
    // Coverage returns one small native tool call. Do not inherit the large
    // Qwen planning floor used for multi-operation manifests.
    minCompletionTokens: Math.min(profile.minCompletionTokens || 1000, 1000),
  }));
  const result = await runOpenRouterChain(messages, profiles, {
    apiKey: openrouterKey,
    purpose: 'manifest_coverage',
    temperature: 0,
    // Medium reasoning consumes from the same completion budget on GPT-OSS;
    // leave enough headroom for both deliberation and the tiny JSON verdict.
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
    };
    const assistantProposal = proposalByKind[parsed.assistantProposalKind] || null;
    const assistantClarification = parsed.assistantClarificationKind === 'reminder_schedule'
      ? {
        kind: 'reminder_schedule',
        subject: typeof parsed.clarificationSubject === 'string'
          ? parsed.clarificationSubject.trim().slice(0, 120)
          : '',
        missingFields: (Array.isArray(parsed.missingFields)
          ? parsed.missingFields
          : []).filter((field) => ['main_time', 'advance_minutes'].includes(field)),
      }
      : null;
    return {
      verdict: parsed.verdict,
      confidence: parsed.confidence,
      manifestRequirement: ['none', 'operations', 'pending_transition'].includes(parsed.manifestRequirement)
        ? parsed.manifestRequirement
        : 'none',
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
      safeResponse: typeof parsed.safeResponse === 'string'
        ? parsed.safeResponse.trim().slice(0, 500)
        : '',
      // A typed scheduling clarification or destructive reminder proposal is
      // operational by construction. Preserve this invariant even if a model
      // returns a contradictory auxiliary memory label.
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
      if (typeof parallelToolCalls === 'boolean') {
        payload.parallel_tool_calls = parallelToolCalls;
      }
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
        console.warn(
          `${logPrefix} attempt purpose=${purpose} stage=${stage} model=${model} provider=${requestedProviders.join(',') || 'default'} outcome=failed reason=${reason} status=${res.status} latencyMs=${Date.now() - startMs} detail="${compactErrorBody(rawBody)}"`,
        );
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
      if (logPrefix) {
        console.warn(
          `${logPrefix} attempt purpose=${purpose} stage=${stage} model=${model} provider=${actualProvider} outcome=failed reason=provider_finish_error latencyMs=${Date.now() - startMs}`,
        );
      }
      return { ok: false, reason: 'provider_finish_error', finishReason };
    }

    if (tools?.length && toolChoice === 'required' && toolCalls.length === 0) {
      if (logPrefix) {
        console.warn(
          `${logPrefix} attempt purpose=${purpose} stage=${stage} model=${model} provider=${actualProvider} outcome=failed reason=required_tool_missing finishReason=${finishReason || 'unknown'} latencyMs=${Date.now() - startMs}`,
        );
      }
      return { ok: false, reason: 'required_tool_missing', finishReason };
    }

    if (!raw && toolCalls.length === 0) {
      const reason = finishReason === 'length' ? 'empty_length' : 'empty_content';
      if (logPrefix) {
        console.warn(
          `${logPrefix} attempt purpose=${purpose} stage=${stage} model=${model} provider=${actualProvider} outcome=failed reason=${reason} finishReason=${finishReason || 'unknown'} latencyMs=${Date.now() - startMs}`,
        );
      }
      return { ok: false, reason, finishReason };
    }

    if (logPrefix) {
      console.log(
        `${logPrefix} attempt purpose=${purpose} stage=${stage} model=${model} provider=${actualProvider} outcome=success finishReason=${finishReason || 'unknown'} toolCalls=${toolCalls.length} promptTokens=${usage.prompt_tokens ?? 'unknown'} completionTokens=${usage.completion_tokens ?? 'unknown'} latencyMs=${Date.now() - startMs}`,
      );
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
    if (logPrefix) {
      console.warn(
        `${logPrefix} attempt purpose=${purpose} stage=${stage} model=${model} provider=${requestedProviders.join(',') || 'default'} outcome=failed reason=${reason} latencyMs=${Date.now() - startMs} detail="${String(error?.message || error).slice(0, 180)}"`,
      );
    }
    return { ok: false, reason };
  }
}

/**
 * Low-level OpenRouter request retained for focused provider tests and image-
 * adjacent integrations. The production planner uses the explicit chain above.
 */
export async function callOpenRouterChat(messages, model, apiKey, options = {}) {
  const attempt = await callOpenRouterAttempt(messages, model, apiKey, options);
  return attempt.ok ? attempt.value : null;
}

/**
 * Independent semantic verification for the small but high-risk state
 * transition that follows a pending clarification. It is intentionally not a
 * phrase matcher: GLM receives the typed pending state and the concrete effect
 * proposed by the primary planner.
 */
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
          transition: {
            type: 'string',
            enum: ['execute_pending', 'discard_pending', 'revise_pending', 'unrelated_turn', 'clarification_request'],
            description: 'execute_pending runs the proposal now; discard_pending leaves it unexecuted and removes it; revise_pending changes details before execution; unrelated_turn means the reply addresses the latest conversation but not the older pending proposal; clarification_request performs no mutation because the reply is ambiguous.',
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['transition', 'confidence'],
      },
    },
  };
  const messages = [
    {
      role: 'system',
      content: `You are a safety verifier for conversational state transitions. The typed proposal is currently NOT EXECUTED. It may schedule something or perform a destructive data operation.
Determine whether the latest user reply actually addresses that pending proposal. Judge meaning in context, not keywords.
The immediately preceding assistant message has conversational priority: if it is an optional invitation, social question, or a different topic, a reply such as a polite decline, thanks, or farewell addresses that latest message and is unrelated_turn; it must not execute or discard an older proposal.
Only use execute_pending, discard_pending, or revise_pending when the reply semantically answers the pending proposal itself. A negative answer to the pending proposal means discard_pending. A qualified approval that changes targets or exceptions is revise_pending. Use clarification_request only when it is genuinely unclear which conversational object the reply addresses. Return exactly one tool call.`,
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
      stage: 'secondary_verifier',
      model: config.secondary,
      providers: config.secondaryProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_SECONDARY_TIMEOUT_MS, 15000),
      maxTokens: 250,
      toolChoice: 'required',
      reasoning: { effort: process.env.OPENROUTER_SECONDARY_REASONING_EFFORT || 'minimal', exclude: true },
    },
    {
      stage: 'last_resort_verifier',
      model: config.lastResort,
      providers: config.lastResortProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_LAST_RESORT_TIMEOUT_MS, 20000),
      maxTokens: 600,
      // Alibaba currently rejects tool_choice=required for Qwen 3.7.
      toolChoice: 'auto',
      reasoning: null,
    },
    {
      stage: 'primary_verifier_fallback',
      model: config.primary,
      providers: config.primaryProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_PRIMARY_TIMEOUT_MS, 15000),
      maxTokens: 250,
      toolChoice: 'required',
      reasoning: { effort: 'minimal', exclude: true },
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
      ) {
        return parsed;
      }
    } catch {
      // The next explicit provider may still return the typed verdict.
    }
  }
  return null;
}

/**
 * Background memory extraction. The legacy export name remains to avoid a
 * broad caller migration. Candidate extraction is GPT-OSS/Groq first for
 * precision, with GLM/Baseten FP8 and Qwen/Alibaba as explicit fallbacks.
 */
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

// Backward-compatible alias for older imports outside the current codebase.
