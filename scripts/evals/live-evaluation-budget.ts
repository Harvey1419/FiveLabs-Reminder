/** Isolated evaluator only. Rates are USD per token, verified by the caller
 * for every allowed model (including zero additional request fees). No pricing
 * lookup, inference retry, credentials, persistence, or production wiring lives here.
 */
export type Rate = { prompt: number; completion: number };

type BudgetOptions = {
  fetch: typeof globalThis.fetch;
  rates: Record<string, Rate>;
  maxCalls: number;
  maxUsd: number;
};
type Attempt = {
  model: string;
  status?: number;
  id?: string;
  responseModel?: string;
  usage?: { promptTokens?: number; completionTokens?: number; cachedTokens?: number; reasoningTokens?: number };
  costUsd?: number;
  accounting: 'pending' | 'known' | 'unknown';
};
const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function tokens(value: unknown): value is number {
  return nonnegative(value) && Number.isSafeInteger(value);
}
function safeLabel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_./:-]{1,200}$/.test(value) ? value : undefined;
}
function usageTotals(value: Record<string, unknown>): Attempt['usage'] | undefined {
  if (!tokens(value.prompt_tokens) || !tokens(value.completion_tokens)) return undefined;
  const promptDetails = record(value.prompt_tokens_details);
  const completionDetails = record(value.completion_tokens_details);
  const cached = promptDetails?.cached_tokens;
  const reasoning = completionDetails?.reasoning_tokens;
  // Cached/reasoning counts are subsets of provider totals, never free tokens.
  if (cached !== undefined && (!tokens(cached) || cached > value.prompt_tokens)) return undefined;
  if (reasoning !== undefined && (!tokens(reasoning) || reasoning > value.completion_tokens)) return undefined;
  return {
    promptTokens: value.prompt_tokens,
    completionTokens: value.completion_tokens,
    ...(cached !== undefined ? { cachedTokens: cached as number } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning as number } : {}),
  };
}

export function createBudgetedTransport(options: BudgetOptions): {
  fetch: typeof globalThis.fetch;
  report(): { calls: number; chargedUsd: number; reservedUsd: number; blockedReason: string | null; attempts: unknown[] };
} {
  if (!Number.isSafeInteger(options.maxCalls) || options.maxCalls <= 0
    || !nonnegative(options.maxUsd) || options.maxUsd === 0) {
    throw new Error('Budget transport: invalid limits');
  }
  const maxCalls = Math.min(60, options.maxCalls);
  const maxUsd = Math.min(0.25, options.maxUsd);
  // Snapshot rates so the caller cannot mutate pricing during concurrent calls.
  const prices = new Map(Object.entries(options.rates).map(([model, rate]) => [model, { ...rate }]));
  const reservations = new Map<Attempt, number>();
  const attempts: Attempt[] = [];
  let calls = 0;
  let chargedUsd = 0;
  let blockedReason: string | null = null;
  const reserved = () => [...reservations.values()].reduce((sum, value) => sum + value, 0);
  function stop(reason: string): never {
    blockedReason ??= reason;
    throw new Error(`Budget transport: ${blockedReason}`);
  }
  function unknown(attempt: Attempt, reason: string): void {
    attempt.accounting = 'unknown';
    blockedReason ??= reason;
    // Deliberately keep the reservation: there is no safe zero-cost assumption.
  }

  const budgetedFetch: typeof globalThis.fetch = async (input, init) => {
    if (blockedReason) stop(blockedReason);
    const target = input instanceof Request ? input.url : String(input);
    if (target !== endpoint) stop('endpoint not allowed');
    let request: Request;
    let text: string;
    try {
      request = new Request(input, init);
      if (request.method !== 'POST') stop('POST required');
      text = await request.clone().text();
    } catch {
      stop('invalid request');
    }
    let payload: Record<string, unknown> | undefined;
    try { payload = record(JSON.parse(text) as unknown); } catch { stop('invalid JSON body'); }
    if (!payload || typeof payload.model !== 'string' || !safeLabel(payload.model)
      || !tokens(payload.max_tokens) || payload.max_tokens === 0) stop('model and positive max_tokens required');
    const model = payload.model;
    const rate = prices.get(model);
    if (!rate || !nonnegative(rate.prompt) || !nonnegative(rate.completion)) stop('valid pricing required');
    const inputBound = new TextEncoder().encode(text).byteLength + 256;
    const reservation = inputBound * rate.prompt + payload.max_tokens * rate.completion;
    if (!Number.isFinite(reservation)) stop('invalid reservation');
    // No await from this check through reservation and dispatch. Each fallback
    // must cross this same seam; simultaneous callers cannot oversubscribe it.
    if (blockedReason) stop(blockedReason);
    if (calls >= maxCalls) stop('call limit');
    if (chargedUsd + reserved() + reservation > maxUsd) stop('USD limit');
    const attempt: Attempt = { model, accounting: 'pending' };
    reservations.set(attempt, reservation);
    attempts.push(attempt);
    calls += 1;
    let response: Response;
    try {
      response = await options.fetch(endpoint, {
        ...init,
        method: 'POST',
        headers: request.headers,
        body: text,
        signal: request.signal,
        redirect: 'error',
      });
    } catch {
      unknown(attempt, 'transport failure');
      throw new Error('Budget transport: transport failure');
    }
    attempt.status = response.status;
    if (response.url && response.url !== endpoint) {
      unknown(attempt, 'unexpected response URL');
      throw new Error('Budget transport: unexpected response URL');
    }
    if (!response.ok) {
      unknown(attempt, 'HTTP error');
      return response;
    }
    let envelope: Record<string, unknown> | undefined;
    try { envelope = record(await response.clone().json() as unknown); } catch {
      unknown(attempt, 'invalid response JSON');
      return response;
    }
    const id = safeLabel(envelope?.id);
    const responseModel = safeLabel(envelope?.model);
    if (id !== undefined) attempt.id = id;
    if (responseModel !== undefined) attempt.responseModel = responseModel;
    const topUsage = record(envelope?.usage);
    const nestedUsage = record(record(envelope?.metadata)?.usage);
    if (topUsage && nestedUsage && (topUsage.cost !== nestedUsage.cost
      || JSON.stringify(usageTotals(topUsage)) !== JSON.stringify(usageTotals(nestedUsage)))) {
      unknown(attempt, 'conflicting usage');
      return response;
    }
    const usage = topUsage ?? nestedUsage;
    if (!envelope || envelope.error !== undefined || !usage) {
      if (envelope?.error) console.error('[BUDGET_TRANSPORT_PROVIDER_ERROR]', JSON.stringify(envelope.error));
      unknown(attempt, 'missing usage or provider error');
      return response;
    }
    const parsedUsage = usageTotals(usage);
    if (parsedUsage !== undefined) attempt.usage = parsedUsage;
    let cost: number;
    if (Object.hasOwn(usage, 'cost')) {
      if (!nonnegative(usage.cost)) {
        unknown(attempt, 'invalid explicit cost');
        return response;
      }
      cost = usage.cost;
    } else {
      const totals = attempt.usage;
      if (!totals || totals.promptTokens === undefined || totals.completionTokens === undefined
        || totals.promptTokens > inputBound || totals.completionTokens > payload.max_tokens
        || (envelope.model !== undefined && envelope.model !== model)) {
        unknown(attempt, 'unverifiable token cost');
        return response;
      }
      cost = totals.promptTokens * rate.prompt + totals.completionTokens * rate.completion;
      if (!nonnegative(cost)) {
        unknown(attempt, 'invalid computed cost');
        return response;
      }
    }
    chargedUsd += cost;
    reservations.delete(attempt);
    attempt.costUsd = cost;
    attempt.accounting = 'known';
    if (!Number.isFinite(chargedUsd) || chargedUsd + reserved() > maxUsd) blockedReason ??= 'USD limit';
    return response;
  };
  return {
    fetch: budgetedFetch,
    report: () => ({ calls, chargedUsd, reservedUsd: reserved(), blockedReason,
      attempts: attempts.map((attempt) => ({ ...attempt, ...(attempt.usage ? { usage: { ...attempt.usage } } : {}) })),
    }),
  };
}
