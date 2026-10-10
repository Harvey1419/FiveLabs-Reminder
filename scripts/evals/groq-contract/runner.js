import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, relative, dirname, sep } from 'node:path';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { loadVariant, hash, validateBaselineRef } from './baseline.js';
import { fixtures, FIXTURE_VERSION, CLOCK, OWNER } from './fixtures.js';
import { gradeDecision, safeDecision } from './grader.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const HOST = 'https://openrouter.ai/api/v1/chat/completions';
// Explicit known-price reservation, not fetched routing prices or a billing claim.
// No discounts: reserve full input plus a full input-sized cache-write contingency.
export const PRICING = Object.freeze({ inputPerMillion: 0.15, outputPerMillion: 0.60,
  cacheWritePerMillion: 0.15, source: 'explicit_known_pricing_assumption', currency: 'USD' });
const usd = value => Math.ceil(value * 1e9) / 1e9;
const runBudgets = new WeakSet();
export const reserveCost = (body, outputLimit) => usd((Buffer.byteLength(body, 'utf8')
  * (PRICING.inputPerMillion + PRICING.cacheWritePerMillion) + outputLimit * PRICING.outputPerMillion) / 1e6);

export function parseOptions(args = []) {
  const options = { live: false, baselineRef: '1290e81', repetitions: 1, pairs: null,
    mode: 'fixed', maxGenerations: null, maxCostUsd: null, explicitKnownPricing: false, output: null };
  let explicitDry = false;
  for (const arg of args) {
    if (arg === '--dry-run') { explicitDry = true; continue; }
    if (arg === '--live') { options.live = true; continue; }
    if (arg === '--explicit-known-pricing') { options.explicitKnownPricing = true; continue; }
    const match = arg.match(/^--(baseline-ref|repetitions|pairs|mode|max-generations|max-cost-usd|output)=(.+)$/);
    if (!match) throw new Error('Unknown or incomplete evaluation option');
    const keys = { 'baseline-ref': 'baselineRef', repetitions: 'repetitions', pairs: 'pairs', mode: 'mode',
      'max-generations': 'maxGenerations', 'max-cost-usd': 'maxCostUsd', output: 'output' };
    options[keys[match[1]]] = ['repetitions', 'pairs', 'max-generations', 'max-cost-usd'].includes(match[1]) ? Number(match[2]) : match[2];
  }
  validateBaselineRef(options.baselineRef);
  if (explicitDry && options.live) throw new Error('Dry-run and live are mutually exclusive');
  if (!['fixed', 'chain'].includes(options.mode)) throw new Error('Unknown pairing mode');
  for (const field of ['repetitions', 'pairs']) if (options[field] !== null
    && (!Number.isSafeInteger(options[field]) || options[field] < 1 || options[field] > 500)) throw new Error('Invalid case count');
  if (options.live) {
    if (!Number.isSafeInteger(options.maxGenerations) || options.maxGenerations < 1 || options.maxGenerations > 100)
      throw new Error('Live requires a generation cap from 1 to 100');
    if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0 || options.maxCostUsd > 5)
      throw new Error('Live requires a positive finite USD cap, maximum 5');
    if (!options.explicitKnownPricing) throw new Error('Live requires explicit known pricing consent; no routing-price fetch occurs');
  }
  if (options.output) {
    if (!options.live) throw new Error('Evidence writes require explicit live mode');
    validateOutputPath(options.output);
  }
  return options;
}

export function validateOutputPath(path, { workspaceRoot = root } = {}) {
  const scope = resolve(workspaceRoot, 'odd/evidence/groq-contract-evaluation');
  const destination = resolve(workspaceRoot, path);
  const tail = relative(scope, destination);
  if (!tail || tail.startsWith('..') || tail.includes(sep) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.json$/.test(tail))
    throw new Error('Evidence must be a new JSON file directly inside the scoped evidence directory');
  let current = workspaceRoot;
  for (const part of relative(workspaceRoot, destination).split(sep)) {
    current = resolve(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || current === destination) throw new Error('Evidence symlinks and overwrites are forbidden');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return destination;
}

/** One run-owned ledger; reservation precedes every attempted POST, including failures. */
export function createBudget({ maxGenerations, maxCostUsd }) {
  if (!Number.isSafeInteger(maxGenerations) || maxGenerations <= 0 || maxGenerations > 100
    || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0 || maxCostUsd > 5) throw new Error('Invalid live budget');
  const receipts = new Set();
  const ledger = { attempts: 0, knownCostUsd: 0, unknownReservedUsd: 0,
    reserve(body, outputLimit) {
      if (!Number.isSafeInteger(outputLimit) || outputLimit <= 0 || outputLimit > 8192) throw new Error('Invalid output reservation');
      const amount = reserveCost(body, outputLimit);
      if (!Number.isFinite(amount) || amount <= 0 || ledger.attempts >= maxGenerations
        || usd(ledger.knownCostUsd + ledger.unknownReservedUsd + amount) > maxCostUsd)
        throw Object.assign(new Error('Budget exhausted'), { code: 'EVALUATION_BUDGET_EXHAUSTED' });
      const receipt = { amount, settled: false };
      receipts.add(receipt);
      ledger.attempts++;
      ledger.unknownReservedUsd = usd(ledger.unknownReservedUsd + amount);
      return receipt;
    },
    reconcile(receipt, cost) {
      if (!receipts.has(receipt) || receipt.settled) throw new Error('Invalid reservation receipt');
      if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return;
      receipt.settled = true;
      ledger.unknownReservedUsd = Math.max(0, usd(ledger.unknownReservedUsd - receipt.amount));
      ledger.knownCostUsd = usd(ledger.knownCostUsd + cost);
    },
  };
  runBudgets.add(ledger);
  return ledger;
}

const identifier = (value, secret) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(value)
  && !(secret && value.includes(secret)) ? value : null;
const counter = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function nativeUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  return { promptTokens: counter(usage.prompt_tokens), completionTokens: counter(usage.completion_tokens),
    reasoningTokens: counter(usage.completion_tokens_details?.reasoning_tokens),
    cachedTokens: counter(usage.prompt_tokens_details?.cached_tokens),
    cacheWriteTokens: counter(usage.prompt_tokens_details?.cache_write_tokens),
    costUsd: counter(usage.cost), upstreamInferenceCostUsd: counter(usage.cost_details?.upstream_inference_cost) };
}
function errorCode(data, secret) {
  const raw = data?.error?.code ?? data?.choices?.[0]?.error?.code;
  // Only typed stable codes; never upstream text or raw nested payloads.
  const codes = new Set(['400', '401', '402', '403', '408', '422', '429', '500', '502', '503',
    'rate_limit_exceeded', 'provider_error', 'invalid_request', 'invalid_request_error', 'content_filter']);
  const value = typeof raw === 'number' || typeof raw === 'string' ? String(raw) : null;
  return codes.has(value) && !(secret && value.includes(secret)) ? value : null;
}

/** No retries/fallbacks. Transport injected in tests; production endpoint is fixed. */
export async function attemptGeneration(prepared, { budget, apiKey, fetch: fetchImpl }) {
  if (!runBudgets.has(budget) || typeof apiKey !== 'string' || !apiKey
    || typeof fetchImpl !== 'function') throw new Error('A live run-owned budget and transport are required');
  const body = prepared.payload;
  if (body.model !== 'openai/gpt-oss-120b' || JSON.stringify(body.provider?.only) !== '["groq"]'
    || JSON.stringify(body.provider?.order) !== '["groq"]' || body.provider.allow_fallbacks !== false
    || body.provider.require_parameters !== true || body.temperature !== 0
    || body.reasoning?.effort !== 'medium' || body.reasoning?.exclude !== true
    || body.tools || body.stream !== false || body.response_format?.json_schema?.strict !== true
    || body.max_tokens !== (prepared.fixture.phase === 'initial' ? 8192 : 4096)
    || prepared.serializedBody !== JSON.stringify(body)) throw new Error('Unsafe evaluation route');
  const receipt = budget.reserve(prepared.serializedBody, body.max_tokens);
  const started = performance.now();
  const result = { status: null, reason: null, errorCode: null, errorProvenance: null,
    generationId: null, requestId: null, usage: null, decision: null, grade: null,
    accepted: false, correctByDeadline: false, latencyMs: null,
    stageElapsed: { preparationMs: prepared.preparationMs, fetchMs: null, parseValidationMs: null } };
  let parseStarted;
  try {
    const response = await fetchImpl(HOST, { method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`, 'HTTP-Referer': 'https://fivelabs.co', 'X-Title': 'Hermes Synthetic Contract Evaluation' },
      body: prepared.serializedBody, signal: AbortSignal.timeout(6000) });
    result.status = response.status;
    result.stageElapsed.fetchMs = performance.now() - started;
    parseStarted = performance.now();
    result.requestId = identifier(response.headers?.get?.('x-request-id'), apiKey);
    let data;
    if (!response.ok) {
      // Parse only to classify typed codes, then discard the raw envelope.
      try { data = JSON.parse(await response.text()); } catch { data = null; }
      result.reason = [400, 401, 402, 403, 408, 422, 429, 500, 502, 503].includes(response.status) ? `http_${response.status}` : 'http_error';
    } else {
      try { data = await response.json(); } catch { result.reason = 'invalid_response_json'; }
    }
    result.errorCode = errorCode(data, apiKey);
    if (data?.error || data?.choices?.[0]?.error) {
      result.reason ||= 'provider_error';
      result.errorProvenance = 'unknown';
    }
    result.generationId = identifier(data?.id, apiKey);
    result.usage = nativeUsage(data?.usage);
    budget.reconcile(receipt, result.usage?.costUsd);
    if (!result.reason) {
      const choice = data?.choices?.[0];
      if (!choice) result.reason = 'missing_decision';
      else if (data.provider && String(data.provider).toLowerCase() !== 'groq') result.reason = 'unexpected_provider';
      else if (choice.message?.refusal || choice.finish_reason === 'content_filter') result.reason = 'provider_refusal';
      else if (choice.finish_reason !== 'stop') result.reason = choice.finish_reason === 'length' ? 'truncated_structured_output' : 'invalid_finish_reason';
      else if (choice.message?.tool_calls?.length) result.reason = 'unexpected_tools';
      else if (typeof choice.message?.content !== 'string' || !choice.message.content.trim()) result.reason = 'missing_decision';
      else {
        const validation = prepared.validateWire(choice.message.content);
        result.accepted = validation.valid === true;
        result.reason = validation.valid ? 'accepted' : 'invalid_structured_output';
        result.errorCode = validation.valid ? null : identifier(validation.errorCode, apiKey);
        result.grade = gradeDecision(prepared.fixture, validation);
        result.decision = safeDecision(validation.intent || validation.decision, prepared.fixture, apiKey);
        // Local-only actual valid decisions for chain receipts, never serialized.
        if (validation.valid) Object.defineProperty(result, 'canonical', { value: validation.intent || validation.decision });
      }
    }
  } catch (error) {
    result.reason = ['AbortError', 'TimeoutError'].includes(error?.name) ? 'timeout' : 'transport_failure';
  }
  const ended = performance.now();
  result.stageElapsed.parseValidationMs = parseStarted == null ? null : ended - parseStarted;
  result.latencyMs = ended - started + prepared.preparationMs;
  result.correctByDeadline = result.accepted && result.grade?.passed === true && result.latencyMs <= 6000;
  if (result.accepted && !result.grade?.passed) result.reason = 'semantic_failure';
  else if (result.accepted && result.latencyMs > 6000) result.reason = 'deadline_exceeded';
  return result;
}

/** Deterministic in-memory receipts, NOT backend persistence verification. */
function chainFixture(fixture, parent) {
  const copy = structuredClone(fixture);
  const canonical = parent.canonical;
  if (!parent.correctByDeadline || !canonical?.actions) return null;
  const expectedDomain = fixture.phase === 'approval' ? ['entity', 'project'] : ['reminder'];
  const drafts = canonical.actions.filter(action => expectedDomain.includes(action.domain));
  if (!drafts.length) return null;
  copy.activeRun = { ...copy.activeRun, preparedActions: drafts.map((payload, index) => ({
    call_id: `call-${index + 1}`, domain: payload.domain, action: payload.action, payload,
    status: 'prepared', target_name: payload.target || payload.content || null,
  })), waiting_for: { ...copy.activeRun.waiting_for, fields: drafts.flatMap(action => action.missingFields || []) } };
  copy.history = [...(fixture.history || []), { role: 'user', content: fixtures.find(item => item.id === fixture.parent).text },
    { role: 'assistant', content: 'Synthetic backend receipt: prepared, not executed.' }];
  return copy;
}

function summarize(pairs, variant) {
  const results = pairs.map(pair => pair.results?.[variant]).filter(Boolean);
  const accepted = results.filter(result => result.correctByDeadline);
  const latencies = accepted.map(result => result.latencyMs).sort((a, b) => a - b);
  const middle = Math.floor(latencies.length / 2);
  return { attempted: results.filter(result => result.status !== null || ['timeout', 'transport_failure'].includes(result.reason)).length,
    correctByDeadline: accepted.length, failures: results.filter(result => !result.correctByDeadline).length,
    acceptedLatencySampleCount: latencies.length,
    medianAcceptedLatencyMs: latencies.length ? latencies.length % 2 ? latencies[middle] : (latencies[middle - 1] + latencies[middle]) / 2 : null,
    nativePromptTokens: results.map(result => result.usage?.promptTokens ?? null),
    nativeCompletionTokens: results.map(result => result.usage?.completionTokens ?? null),
    failureReasons: Object.fromEntries([...new Set(results.filter(result => !result.correctByDeadline).map(result => result.reason))]
      .map(reason => [reason, results.filter(result => !result.correctByDeadline && result.reason === reason).length])) };
}

export async function runComparison(input, { getKey = () => process.env.OPENROUTER_API_KEY, fetch: fetchImpl = globalThis.fetch, readSource } = {}) {
  // Revalidate programmatic callers before ANY credential lookup.
  const args = [`--baseline-ref=${input.baselineRef}`, `--repetitions=${input.repetitions}`, `--mode=${input.mode}`,
    ...(input.pairs == null ? [] : [`--pairs=${input.pairs}`]),
    ...(input.live ? ['--live', `--max-generations=${input.maxGenerations}`, `--max-cost-usd=${input.maxCostUsd}`,
      ...(input.explicitKnownPricing ? ['--explicit-known-pricing'] : [])] : ['--dry-run']),
    ...(input.output ? [`--output=${input.output}`] : [])];
  const options = parseOptions(args);
  const variants = { baseline: loadVariant(options.baselineRef, { readSource }), current: loadVariant(null, { readSource }) };
  if (variants.baseline.policyVersion !== variants.current.policyVersion
    || Object.entries(variants.current.hashes).some(([path, digest]) => variants.baseline.hashes[path] !== digest))
    throw new Error('Current runtime sources changed during source snapshot');
  const budget = options.live ? createBudget(options) : null;
  const apiKey = options.live ? getKey() : null;
  if (options.live && !apiKey) throw new Error('Explicit live run requires caller-provided OPENROUTER_API_KEY');
  const pairCount = options.pairs ?? fixtures.length * options.repetitions;
  const pairs = [], parents = new Map();
  let forecastCost = 0, preparedGenerations = 0;
  for (let index = 0; index < pairCount; index++) {
    const fixture = fixtures[index % fixtures.length], repetition = Math.floor(index / fixtures.length);
    const order = (index + repetition) % 2 === 0 ? ['baseline', 'current'] : ['current', 'baseline'];
    const pair = { pair: index + 1, caseId: fixture.id, phase: fixture.phase, repetition: repetition + 1, order, matched: true,
      inputHashRelation: 'equal', inputHashes: {}, bytes: {}, results: {} };
    const contexts = {};
    for (const variant of order) {
      let ownedFixture = fixture;
      if (options.mode === 'chain' && fixture.parent) {
        const parent = parents.get(`${repetition}:${fixture.parent}:${variant}`);
        ownedFixture = parent ? chainFixture(fixture, parent) : null;
        if (!ownedFixture) {
          pair.results[variant] = { status: null, reason: 'parent_failed', correctByDeadline: false, decision: null };
          pair.matched = false;
          continue;
        }
      }
      const prepared = variants[variant].prepare(ownedFixture);
      preparedGenerations++;
      contexts[variant] = prepared.payload.messages;
      pair.inputHashes[variant] = hash(prepared.payload.messages);
      pair.bytes[variant] = Buffer.byteLength(prepared.serializedBody, 'utf8');
      pair.bytes[`${variant}Messages`] = Buffer.byteLength(JSON.stringify(prepared.payload.messages), 'utf8');
      pair.bytes[`${variant}Schema`] = Buffer.byteLength(JSON.stringify(prepared.payload.response_format.json_schema.schema), 'utf8');
      forecastCost = usd(forecastCost + reserveCost(prepared.serializedBody, prepared.payload.max_tokens));
      if (!options.live) {
        const grade = gradeDecision(ownedFixture, prepared.validation);
        pair.results[variant] = { kind: 'offline_fixture_smoke_not_model_evaluation',
          valid: prepared.validation.valid, grade, decision: safeDecision(prepared.validation.intent || prepared.validation.decision, ownedFixture) };
        // Chain smoke is valid fixture-driven simulation, never provider success.
        const smoke = { correctByDeadline: grade.passed };
        Object.defineProperty(smoke, 'canonical', { value: prepared.validation.intent || prepared.validation.decision });
        parents.set(`${repetition}:${fixture.id}:${variant}`, smoke);
      } else {
        let result;
        try { result = await attemptGeneration(prepared, { budget, apiKey, fetch: fetchImpl }); }
        catch (error) { result = { status: null,
          reason: error?.code === 'EVALUATION_BUDGET_EXHAUSTED' ? 'budget_exhausted' : 'setup_failure',
          correctByDeadline: false, decision: null }; }
        pair.results[variant] = result;
        parents.set(`${repetition}:${fixture.id}:${variant}`, result);
      }
    }
    pair.matched &&= Boolean(contexts.baseline && contexts.current && hash(contexts.baseline) === hash(contexts.current));
    pair.inputHashRelation = pair.matched ? 'equal' : 'unmatched_or_divergent';
    pair.bytes.saved = pair.matched ? pair.bytes.baseline - pair.bytes.current : null;
    if (options.live) {
      const before = pair.results.baseline?.usage?.promptTokens, after = pair.results.current?.usage?.promptTokens;
      pair.nativePromptTokenDelta = pair.matched && typeof before === 'number' && typeof after === 'number' ? before - after : null;
    }
    pairs.push(pair);
  }
  const report = { formatVersion: 1, fixtureVersion: FIXTURE_VERSION, synthetic: true, owner: OWNER,
    referenceTime: CLOCK, mode: options.live ? 'live' : 'dry-run', pairing: options.mode,
    comparisonMode: 'mixed_source_schema_only',
    fixtureCount: fixtures.length, caseMix: 'balanced_deterministic_cycle',
    caseCounts: Object.fromEntries(fixtures.map(fixture => [fixture.id, pairs.filter(pair => pair.caseId === fixture.id).length])),
    scope: 'in_memory_only:no_persisted_backend_verification', pairCount,
    matchedPairCount: pairs.filter(pair => pair.matched).length, attempts: budget?.attempts ?? 0,
    forecast: { generations: preparedGenerations, plannedMaxGenerations: pairCount * 2, maxReservedUsd: forecastCost,
      components: 'wire_message_schema_byte_counts_are_non_additive',
      inputBound: 'utf8_full_wire_bytes_as_conservative_input_token_upper_bound_not_native_tokens',
      pricing: PRICING, nativeTokens: null, latencyMs: null },
    cost: budget ? { knownUsd: budget.knownCostUsd, unknownReservedUsd: budget.unknownReservedUsd } : null,
    nativeUsage: options.live ? { baseline: summarize(pairs, 'baseline'), current: summarize(pairs, 'current') } : null,
    sources: Object.fromEntries(Object.entries(variants).map(([key, value]) => [key, {
      sourceCommit: value.sourceCommit, baselineSchemaCommit: value.baselineSchemaCommit,
      sourceKind: key === 'baseline' ? 'current_runtime_baseline_projection' : 'current_runtime_current_projection',
      fileHashes: value.hashes, schemaVersion: value.schemaVersion,
      policyVersion: value.policyVersion, provenance: value.provenance,
    }])), pairs };
  if (options.output) {
    const path = validateOutputPath(options.output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await runComparison(parseOptions(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch {
    // Configuration or source failures never dump freeform exceptions/private payloads.
    process.stderr.write('Groq evaluation stopped: invalid configuration, source boundary, or execution setup.\n');
    process.exitCode = 1;
  }
}
