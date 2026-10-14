import { describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRequestPayload } from '../../../src/agent/providers/request-payload.js';
import { validateForegroundContent } from '../../../src/agent/contracts/foreground-turn-validation.js';
import { loadVariant as variantBoundary, validateBaselineRef, evaluateModule, loadLegacyRequestBuilder, hash } from '../../../scripts/evals/groq-contract/baseline.js';
import { fixtures as fixtureBoundary } from '../../../scripts/evals/groq-contract/fixtures.js';
import { gradeDecision, safeDecision as safeDecisionBoundary } from '../../../scripts/evals/groq-contract/grader.js';
import { parseOptions, runComparison as comparisonBoundary, createBudget, attemptGeneration, validateOutputPath } from '../../../scripts/evals/groq-contract/runner.js';

import type { EvaluationAction, EvaluationDecision, EvaluationFixture } from '../../../scripts/evals/groq-contract/fixtures.js';
type CapturedAction = EvaluationAction;
type CapturedWire = EvaluationDecision & {
  actions: CapturedAction[]; actionInputs: { callId: string; fields: CapturedAction }[];
};
type CapturedFixture = EvaluationFixture & { wire: CapturedWire };
const fixtures = fixtureBoundary as CapturedFixture[];
function loadVariant(...args: Parameters<typeof variantBoundary>) {
  type Variant = ReturnType<typeof variantBoundary>;
  type Prepared = ReturnType<Variant['prepare']>;
  return variantBoundary(...args) as Omit<Variant, 'prepare'> & {
    prepare(...args: Parameters<Variant['prepare']>): Omit<Prepared, 'fixtureWire' | 'payload'> & { fixtureWire: CapturedWire; payload: Omit<Prepared['payload'], 'messages'> & { messages: { role: string; content: string }[] } };
  };
}
function safeDecision(...args: Parameters<typeof safeDecisionBoundary>) {
  return safeDecisionBoundary(...args) as unknown as CapturedWire;
}
function runComparison(...args: Parameters<typeof comparisonBoundary>) {
  type Report = Awaited<ReturnType<typeof comparisonBoundary>>;
  type Result = NonNullable<Report['pairs'][number]['results']['baseline']>;
  return comparisonBoundary(...args) as Promise<Omit<Report, 'pairs'> & {
    pairs: (Omit<Report['pairs'][number], 'results'> & { results: { baseline: Result; current: Result } })[];
  }>;
}

const wireReply = { responseLanguage: 'es', responseCapability: 'general', learningCandidates: [],
  actions: [{ operation: 'conversation.reply', content: 'Hola.', evidenceRefs: ['invented'] }] };

describe('reproducible offline Groq comparison', () => {
  it.each([
    ['reminder-time', { schedule: { minute: 59 } }],
    ['dated-reminder', { content: 'Completely different reminder' }],
    ['missing-time', { content: 'Completely different reminder' }],
    ['reminder-time', { content: 'Completely different reminder' }],
    ['reminder-time', { schedule: { hour: 16 } }],
    ['reminder-time', { schedule: { hour: 3, clockMode: 'explicit_am' } }],
    ['reminder-time', { schedule: { hour: 3, clockMode: 'ambiguous_12h' } }],
    ['reminder-time', { schedule: { kind: 'relative_day_time', dayOffset: 2 } }],
    ['dated-reminder', { schedule: { minute: 59 } }],
    ['dated-reminder', { schedule: { hour: 16 } }],
    ['dated-reminder', { schedule: { hour: 15, clockMode: 'explicit_am' } }],
    ['dated-reminder', { schedule: { allDay: true } }],
    ['dated-reminder', { schedule: { year: 2027 } }],
    ['dated-reminder', { schedule: { month: 11 } }],
    ['dated-reminder', { schedule: { day: 10 } }],
    ['missing-time', { schedule: { dayOffset: 2 } }],
    ['missing-time', { schedule: { minute: 59 } }],
    ['ampm-ambiguity', { content: 'Completely different reminder' }],
    ['english-missing-time', { content: 'Completely different reminder' }],
    ['english-neutral-time', { content: 'Completely different reminder' }],
  ])('rejects canonical-valid semantic mutation in %s: %j', (id, change) => {
    const variant = loadVariant(null), fixture = fixtures.find(item => item.id === id)!;
    const wire = structuredClone(fixture.wire);
    const action = fixture.phase === 'continuation' ? wire.actionInputs[0]!.fields : wire.actions[0]!;
    for (const [field, value] of Object.entries(change)) {
      action[field] = field === 'schedule' ? { ...action.schedule, ...value } : value;
    }
    const validation = variant.validate(JSON.stringify(wire), fixture);
    expect(validation.valid, 'negative probe must cross the actual canonical validator').toBe(true);
    expect(gradeDecision(fixture, validation).passed).toBe(false);
  });

  it.each([
    ['missing-time', '  LLAMAR   AL DENTÍSTA.  '],
    ['dated-reminder', 'Llamar a mi dentista'],
    ['dated-reminder', 'Recordatorio: llamar al dentista.'],
    ['ampm-ambiguity', 'Llamar al odontólogo'],
    ['reminder-time', 'Llamar a mi dentista'],
    ['english-missing-time', 'Purchase the costume.'],
    ['english-neutral-time', 'Reminder: buy the costume.'],
  ])('accepts declared fixture subject equivalence in %s: %s', (id, content) => {
    const variant = loadVariant(null), fixture = fixtures.find(item => item.id === id)!;
    const wire = structuredClone(fixture.wire);
    if (fixture.phase === 'continuation') wire.actionInputs[0]!.fields.content = content;
    else wire.actions[0]!.content = content;
    const validation = variant.validate(JSON.stringify(wire), fixture);
    expect(validation.valid).toBe(true);
    expect(gradeDecision(fixture, validation).passed).toBe(true);
  });

  it.each(['reminder-time', 'dated-reminder'])('accepts canonical omitted minute as inferred zero in %s', id => {
    const variant = loadVariant(null), fixture = fixtures.find(item => item.id === id)!;
    const wire = structuredClone(fixture.wire);
    const action = fixture.phase === 'continuation' ? wire.actionInputs[0]!.fields : wire.actions[0]!;
    delete action.schedule!.minute;
    const validation = variant.validate(JSON.stringify(wire), fixture);
    expect(validation.valid).toBe(true);
    expect(gradeDecision(fixture, validation).passed).toBe(true);
  });

  it('accepts explicit 12-hour PM representation where the actual initial contract permits it', () => {
    const variant = loadVariant(null), fixture = fixtures.find(item => item.id === 'dated-reminder')!;
    const wire = structuredClone(fixture.wire);
    Object.assign(wire.actions[0]!.schedule!, { hour: 3, clockMode: 'explicit_pm' });
    const validation = variant.validate(JSON.stringify(wire), fixture);
    expect(validation.valid).toBe(true);
    expect(gradeDecision(fixture, validation).passed).toBe(true);
  });

  it('preserves the pending subject without requiring a continuation content field', () => {
    const variant = loadVariant(null), fixture = fixtures.find(item => item.id === 'reminder-time')!;
    const prepared = variant.prepare(fixture), validation = prepared.validation;
    expect(prepared.serializedBody).not.toContain('owned-fake-fixture:grader-only');
    expect(prepared.serializedBody).not.toContain('Recordatorio: llamar al dentista');
    expect(validation.valid).toBe(true);
    expect(validation.decision!.actionInputs![0]!.fields).not.toHaveProperty('content');
    const grade = gradeDecision(fixture, validation);
    expect(grade.assertions.find(item => item.id === 'reminder_subject')!.passed).toBe(true);
    expect(grade.passed).toBe(true);
  });

  it('accepts an equivalent explicit calendar date for the owned tomorrow draft', () => {
    const variant = loadVariant(null), fixture = fixtures.find(item => item.id === 'missing-time')!;
    const wire = structuredClone(fixture.wire);
    wire.actions[0]!.schedule = { kind: 'calendar_date_time', year: 2026, month: 10, day: 9 };
    const validation = variant.validate(JSON.stringify(wire), fixture);
    expect(validation.valid).toBe(true);
    expect(gradeDecision(fixture, validation).passed).toBe(true);
    delete wire.actions[0]!.schedule!.year;
    const inferredYear = variant.validate(JSON.stringify(wire), fixture);
    expect(inferredYear.valid).toBe(true);
    expect(gradeDecision(fixture, inferredYear).passed).toBe(true);
  });

  it('marks undeclared subject paraphrases unresolved rather than claiming a backend bug', () => {
    const variant = loadVariant(null), fixture = fixtures.find(item => item.id === 'dated-reminder')!;
    const wire = structuredClone(fixture.wire);
    wire.actions[0]!.content = 'Contact the dental office';
    const validation = variant.validate(JSON.stringify(wire), fixture);
    expect(validation.valid).toBe(true);
    const grade = gradeDecision(fixture, validation);
    expect(grade.passed).toBe(false);
    expect(grade.assertions.find(item => item.id === 'reminder_subject')).toMatchObject({ passed: false, outcome: 'unresolved' });
  });
  it('preserves exact outer wire fields and omits unsupported/absent options', () => {
    const messages = [{ role: 'user', content: 'Hola' }];
    const responseFormat = { type: 'json_schema', json_schema: { strict: true, schema: {} } };
    expect(buildRequestPayload(messages, 'openai/gpt-oss-120b', { temperature: 0, max_tokens: 8192,
      responseFormat, providers: ['groq'], reasoning: { effort: 'medium', exclude: true }, tools: null }))
      .toEqual({ model: 'openai/gpt-oss-120b', messages, temperature: 0, max_tokens: 8192, stream: false,
        response_format: responseFormat, reasoning: { effort: 'medium', exclude: true },
        provider: { order: ['groq'], only: ['groq'], allow_fallbacks: false, require_parameters: true } });
    const body = JSON.stringify(buildRequestPayload(messages, 'other', { temperature: undefined, max_tokens: 4096 }));
    expect(JSON.parse(body)).toEqual({ model: 'other', messages, max_tokens: 4096 });
    expect(buildRequestPayload(messages, 'other', { tools: [{ type: 'function' }], parallelToolCalls: false }))
      .toMatchObject({ tool_choice: 'auto', parallel_tool_calls: false });
  });

  it('uses the real initial no-history sanitizer and preserves owned-history rejection', () => {
    expect(validateForegroundContent(JSON.stringify(wireReply), { hasHistoricalEvidence: false }).valid).toBe(true);
    expect(validateForegroundContent(JSON.stringify(wireReply), { hasHistoricalEvidence: true }).valid).toBe(false);
  });

  it('strips stale profile evidence for reads but rejects related mutations', () => {
    const payload = { ...wireReply, actions: [{ operation: 'task.list', status: 'all' }],
      profileUpdate: { sourceQuote: 'From now on use English.', language: 'en' } };
    const options = { hasHistoricalEvidence: false, currentUserText: 'List tasks.' };
    const read = validateForegroundContent(JSON.stringify(payload), options);
    expect(read.valid).toBe(true);
    expect((read as Extract<typeof read, { valid: true }>).intent).not.toHaveProperty('profileUpdate');
    expect(validateForegroundContent(JSON.stringify({ ...payload,
      actions: [{ operation: 'task.create', title: 'Buy milk', projectless: true }] }), options).valid).toBe(false);
  });

  it.each(['--help', '-HEAD', 'HEAD:path', 'HEAD~1', 'main;whoami', 'origin/main', '', '1290e81\n'])
    ('rejects non-local/unsafe baseline reference %j', ref => expect(() => validateBaselineRef(ref)).toThrow());

  it('denies unknown imports before evaluating source', () => {
    expect(() => evaluateModule("import x from 'node:fs'; export const result = x;", () => { throw new Error('Denied import'); }))
      .toThrow('Denied import');
  });

  it('loads immutable baseline and current builders with per-file hashes and actual canonical validators', () => {
    const before = loadVariant('1290e81');
    const after = loadVariant(null);
    expect(before.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(after.hashes['src/agent/providers/request-payload.ts']).toMatch(/^[a-f0-9]{64}$/);
    for (const fixture of fixtures) {
      const a = before.prepare(fixture), b = after.prepare(fixture);
      expect(a.payload.messages).toEqual(b.payload.messages);
      expect(a.validation.valid, fixture.id).toBe(true);
      expect(b.validation.valid, fixture.id).toBe(true);
      expect(gradeDecision(fixture, b.validation).passed, fixture.id).toBe(true);
    }
  });

  it('isolates schema compaction with the same CURRENT English prompt and runtime guard provenance', () => {
    const english = { ...fixtures[0]!, text: 'Hello', context: { ...fixtures[0]!.context, language: 'en' },
      history: [{ role: 'assistant', content: '¿A qué hora?' }] };
    const baseline = loadVariant('1290e81'), current = loadVariant(null);
    const before = baseline.prepare(english), after = current.prepare(english);
    expect(before.payload.messages).toEqual(after.payload.messages);
    expect(before.payload.messages[0]!.content).toContain('MANDATORY TARGET LANGUAGE: ENGLISH');
    expect(baseline.comparisonMode).toBe('mixed_source_schema_only');
    expect(baseline.policyVersion).toBe(current.policyVersion);
    expect(baseline.provenance.find(file => file.path === 'src/agent/core/agent-core.ts')!.origin).toBe('current_working_tree');
    expect(baseline.provenance.find(file => file.role === 'comparison_schema')!.origin).toBe('baseline_commit');
    for (const path of ['src/agent/orchestration/router-core.ts', 'src/agent/orchestration/domain-call.ts', 'src/agent/orchestration/intent-executor.ts'])
      expect(baseline.provenance.some(file => file.path === path && file.role === 'language_guard_read_only')).toBe(true);
  });

  it.each(['src/agent/orchestration/router-active-run.ts', 'src/agent/orchestration/router-foreground-decision.ts', 'src/agent/orchestration/router-action-preparation.ts', 'src/agent/orchestration/router-execution-boundary.ts', 'src/agent/orchestration/router-observed-reply.ts', 'src/agent/orchestration/router-turn-lifecycle.ts', 'src/agent/orchestration/router-turn-initialization.ts', 'src/agent/orchestration/router-pipeline.ts', 'src/agent/orchestration/next-best-action-core.ts', 'src/agent/orchestration/clarification-state.ts', 'src/agent/orchestration/clarification-presentation-core.ts', 'src/agent/orchestration/observed-task-fields.ts', 'src/agent/orchestration/historical-evidence.ts', 'src/agent/orchestration/observed-answer-core.ts', 'src/agent/orchestration/router-assembly.ts', 'src/shared/current-user-input-policy.ts', 'src/shared/language-detection-policy.ts', 'src/shared/admin-policy.ts', 'src/shared/current-user-input.ts', 'src/shared/auth.ts', 'src/agent/tools/reminder-pro-context.ts', 'src/agent/tools/reminder-pro.ts', 'src/integrations/google/google-auth.ts', 'src/infrastructure/database/subscription-policy.ts', 'src/infrastructure/database/subscription-persistence.ts', 'src/infrastructure/database/subscriptions.ts', 'src/integrations/stripe/checkout-client.ts', 'src/integrations/stripe/client.ts', 'src/infrastructure/database/database-client.ts', 'src/integrations/whatsapp/kapso-errors.ts', 'src/integrations/whatsapp/kapso-dispatch.ts', 'src/http/webhooks/billing-webhook-ports.ts', 'src/http/webhooks/stripe-handler.ts', 'src/http/webhooks/stripe.ts', 'src/jobs/memory-extraction-queue.ts', 'src/jobs/memory-extractor.ts', 'src/integrations/stripe/subscription-client.ts', 'src/features/calendar/watch-ports.ts', 'src/http/webhooks/user-webhook-queue.ts', 'src/http/webhooks/google-calendar-handler.ts', 'src/jobs/calendar-watch-renewal-core.ts', 'src/http/webhooks/google-calendar.ts', 'src/jobs/calendar-watch-renewal.ts', 'src/infrastructure/database/reminder-persistence-client.ts', 'src/infrastructure/database/reminder-persistence.ts', 'src/infrastructure/database/reminder-delivery-persistence.ts', 'src/infrastructure/database/reminder-overview.ts', 'src/infrastructure/database/index.ts'])('hashes %s as read-only policy without evaluating its effect ports', path => {
    const current = loadVariant(null);
    expect(current.hashes[path]).toBe(hash(readFileSync(new URL('../../../' + path, import.meta.url), 'utf8')));
    expect(current.provenance.find(file => file.path === path)).toMatchObject({ role: 'language_guard_read_only' });
    const altered = loadVariant(null, { readSource: requested => {
      const source = readFileSync(new URL('../../../' + requested, import.meta.url), 'utf8');
      return requested === path ? source + "\nthrow new Error('Never evaluate effect orchestration');\n" : source;
    } });
    expect(altered.policyVersion).not.toBe(current.policyVersion);
    expect(altered.prepare(fixtures[0]!).payload.messages).toEqual(current.prepare(fixtures[0]!).payload.messages);
  });

  it('records the original TypeScript prompt hash in current policy provenance', () => {
    const path = 'src/agent/core/active-run-prompt.ts';
    const current = loadVariant(null);
    expect(current.hashes[path]).toBe(hash(readFileSync(new URL('../../../' + path, import.meta.url), 'utf8')));
    expect(current.provenance.find(file => file.path === path)).toMatchObject({ origin: 'current_working_tree', role: 'current_runtime' });
    const altered = loadVariant(null, { readSource: requested => {
      const source = readFileSync(new URL('../../../' + requested, import.meta.url), 'utf8');
      return requested === path ? source.replace('readonly id: string;', 'readonly id: string | number;') : source;
    } });
    expect(altered.policyVersion).not.toBe(current.policyVersion);
    expect(altered.prepare(fixtures[0]!).payload.messages).toEqual(current.prepare(fixtures[0]!).payload.messages);
  });

  it('refuses an effect-owning dependency added to the pure TypeScript prompt', () => {
    expect(() => loadVariant(null, { readSource: path => {
      const source = readFileSync(new URL('../../../' + path, import.meta.url), 'utf8');
      return path === 'src/agent/core/active-run-prompt.ts'
        ? source + "\nimport { getActiveRunFromDb } from '../../infrastructure/database/agent-runs.js';\n" : source;
    } })).toThrow('Denied import');
  });

  it('changes policy provenance when the current English lock changes even if TURN_LANGUAGE_POLICY is unchanged', () => {
    const current = loadVariant(null);
    const altered = loadVariant(null, { readSource: path => {
      const source = readFileSync(new URL('../../../' + path, import.meta.url), 'utf8');
      return path === 'src/agent/core/agent-prompt.ts' ? source.replace('MANDATORY TARGET LANGUAGE: ENGLISH', 'Synthetic removed lock') : source;
    } });
    expect(altered.policyVersion).not.toBe(current.policyVersion);
  });

  it('labels source/setup failures distinctly from exhausted budgets and never posts an unsafe route', async () => {
    const fetch = vi.fn();
    const report = await runComparison(parseOptions(['--live', '--pairs=1', '--max-generations=2', '--max-cost-usd=1', '--explicit-known-pricing']), {
      getKey: () => 'unit-only-key', fetch, readSource: path => {
        const source = readFileSync(new URL('../../../' + path, import.meta.url), 'utf8');
        return path === 'src/agent/providers/gateway-request-payload.ts' ? source.replace('return payload;', 'payload.temperature = 1; return payload;') : source;
      },
    });
    expect(report.pairs[0]!.results.current.reason).toBe('setup_failure');
    expect(report.attempts).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["import('node:fs')", "import x from 'node:fs';", "import * as x from 'node:fs';", "export default 1;", "export { x };"])
    ('denies unsupported module layout %s', source => expect(() => evaluateModule(source, () => { throw new Error('Denied import'); })).toThrow());

  it('never gives evaluated source process or fetch capabilities', () => {
    for (const source of ["export const result = process.env.OPENROUTER_API_KEY;", "export const result = fetch('https://example.invalid');"])
      expect(() => evaluateModule(source, () => { throw new Error('Denied import'); })).toThrow();
  });

  it('rejects artifact overwrites and symlinks in isolated test fixtures', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'groq-eval-unit-'));
    try {
      const scope = join(workspaceRoot, 'odd/evidence/groq-contract-evaluation');
      mkdirSync(scope, { recursive: true });
      writeFileSync(join(scope, 'existing.json'), '{}');
      symlinkSync(workspaceRoot, join(scope, 'escape.json'));
      expect(validateOutputPath('odd/evidence/groq-contract-evaluation/new.json', { workspaceRoot })).toBe(join(scope, 'new.json'));
      for (const name of ['existing', 'escape']) expect(() => validateOutputPath(`odd/evidence/groq-contract-evaluation/${name}.json`, { workspaceRoot })).toThrow();
    } finally { rmSync(workspaceRoot, { recursive: true, force: true }); }
  });

  it('keeps legacy-to-shared request parity across supported options and both actual output limits', () => {
    const legacy = loadLegacyRequestBuilder('1290e81');
    const messages = [{ role: 'user', content: 'Synthetic parity only' }];
    for (const max_tokens of [8192, 4096]) for (const temperature of [0, undefined]) for (const tools of [null, [], [{ type: 'function', function: { name: 'synthetic' } }]]) {
      const options = { temperature, max_tokens, tools, toolChoice: 'none', parallelToolCalls: false,
        responseFormat: { type: 'json_schema', json_schema: { strict: true, schema: {} } },
        reasoning: { effort: 'medium', exclude: true }, providers: ['groq'], allowProviderFallbacks: false };
      expect(JSON.stringify(buildRequestPayload(messages, 'openai/gpt-oss-120b', options)))
        .toBe(JSON.stringify(legacy(messages, 'openai/gpt-oss-120b', options)));
    }
    for (const responseFormat of [null, { type: 'json_object' }]) {
      const options = { temperature: 0, max_tokens: 4096, tools: [], toolChoice: 'auto', reasoning: null,
        responseFormat, providers: [], allowProviderFallbacks: false };
      expect(JSON.stringify(buildRequestPayload(messages, 'other-model', options))).toBe(JSON.stringify(legacy(messages, 'other-model', options)));
    }
  });

  it('denies production imports and environment/network access in evaluated pure modules', () => {
    expect(() => evaluateModule("export const result = process.env.OPENROUTER_API_KEY;", () => { throw new Error('Denied import'); })).toThrow();
    expect(() => evaluateModule("export const result = fetch('https://example.invalid');", () => { throw new Error('Denied import'); })).toThrow();
    expect(() => loadVariant(null, { readSource: path => path.endsWith('intent-contracts.ts')
      ? "import { x } from '../../infrastructure/database/index.js'; export const result = x;" : '' })).toThrow('Denied import');
  });

  it.each(['odd/evidence/groq-contract-evaluation/../escape.json', 'odd/evidence/groq-contract-evaluation/nested/run.json',
    '/tmp/run.json', 'odd/tasks/overwrite.json'])('rejects artifact path escapes %s', path => expect(() => validateOutputPath(path)).toThrow());

  it('defaults to deterministic dry-run without consulting keys or fetch', async () => {
    const getKey = vi.fn(() => { throw new Error('Credential lookup forbidden'); });
    const fetch = vi.fn(() => { throw new Error('Network forbidden'); });
    const options = parseOptions(['--dry-run', '--baseline-ref=1290e81', '--pairs=50']);
    const report = await runComparison(options, { getKey, fetch });
    expect(report.pairCount).toBe(50);
    expect(report.forecast.generations).toBe(100);
    expect(report.attempts).toBe(0);
    expect(report.forecast.maxReservedUsd).toBeGreaterThan(0);
    expect(report.pairs[0]!.order).toEqual(['baseline', 'current']);
    expect(report.pairs[1]!.order).toEqual(['current', 'baseline']);
    expect(report.pairs[0]!.matched).toBe(true);
    expect(report.pairs[0]!.bytes.saved).toBeGreaterThan(1200);
    expect(report.nativeUsage).toBeNull();
    expect(report.matchedPairCount).toBe(50);
    expect(report.comparisonMode).toBe('mixed_source_schema_only');
    expect(Math.max(...Object.values(report.caseCounts)) - Math.min(...Object.values(report.caseCounts))).toBeLessThanOrEqual(1);
    expect(getKey).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([['--live'], ['--live', '--max-generations=0', '--max-cost-usd=1'],
    ['--live', '--max-generations=2', '--max-cost-usd=NaN'],
    ['--live', '--max-generations=2', '--max-cost-usd=Infinity', '--explicit-known-pricing'],
    ['--live', '--max-generations=2', '--max-cost-usd=-1', '--explicit-known-pricing'],
    ['--live', '--max-generations=Infinity', '--max-cost-usd=1', '--explicit-known-pricing'],
    ['--live', '--max-generations=2', '--max-cost-usd=1'], ['--output=../../escape'], ['--pairs=0']])
    ('fails closed on invalid execution options %j', (args: string, ..._unused: string[]) => expect(() => parseOptions(args as unknown as string[])).toThrow());

  it('counts attempted failures and retains unknown-cost reserves without resetting caps', async () => {
    const budget = createBudget({ maxGenerations: 1, maxCostUsd: 1 });
    const variant = loadVariant(null), prepared = variant.prepare(fixtures[0]!);
    const fetch = vi.fn(async () => ({ ok: false, status: 429, headers: new Headers(), text: async () => '{}' }));
    const result = await attemptGeneration(prepared, { budget, apiKey: 'unit-only-key', fetch });
    expect(result.status).toBe(429);
    expect(result.reason).toBe('http_429');
    expect(budget.attempts).toBe(1);
    expect(budget.unknownReservedUsd).toBeGreaterThan(0);
    expect(() => budget.reserve(prepared.serializedBody, 8192)).toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains HTTP-200 typed errors and missing native usage as unknown', async () => {
    const prepared = loadVariant(null).prepare(fixtures[0]!);
    const budget = createBudget({ maxGenerations: 2, maxCostUsd: 1 });
    const result = await attemptGeneration(prepared, { budget, apiKey: 'unit-only-key', fetch: async () => ({
      ok: true, status: 200, headers: new Headers(), json: async () => ({ error: { code: 429, message: 'unit-only-key raw error' } }),
    }) });
    expect(result.reason).toBe('provider_error');
    expect(result.errorCode).toBe('429');
    expect(result.usage).toBeNull();
    expect(JSON.stringify(result)).not.toContain('unit-only-key');
    expect(JSON.stringify(result)).not.toContain('raw error');
  });

  it('accepts actual strict fixture decisions, retains native billing counters, and scrubs generation IDs', async () => {
    const prepared = loadVariant(null).prepare(fixtures.find(item => item.id === 'second-description')!)!;
    const budget = createBudget({ maxGenerations: 1, maxCostUsd: 1 });
    const result = await attemptGeneration(prepared, { budget, apiKey: 'unit-only-key', fetch: async (host, options) => {
      expect(host).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(options.body).toBe(prepared.serializedBody);
      return { ok: true, status: 200, headers: new Headers({ 'x-request-id': 'req-synthetic-1' }), json: async () => ({
        id: 'gen-unit-only-key', provider: 'Groq', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(prepared.fixtureWire) } }],
        usage: { prompt_tokens: 5000, completion_tokens: 200, cost: 0.001,
          prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 100 } },
      }) };
    } });
    expect(result.correctByDeadline).toBe(true);
    expect(result.usage).toMatchObject({ promptTokens: 5000, cachedTokens: 50, cacheWriteTokens: 20, costUsd: 0.001 });
    expect(result.generationId).toBeNull();
    expect(result.requestId).toBe('req-synthetic-1');
    expect((result.decision as unknown as CapturedWire).actions[0]!).toMatchObject({ query: 'Second task', returnFields: ['description'] });
    expect(budget.knownCostUsd).toBe(0.001);
    expect(budget.unknownReservedUsd).toBe(0);
  });

  it.each([400, 429, 'timeout'])('counts failed attempted generation %s against both hard caps', async status => {
    const prepared = loadVariant(null).prepare(fixtures[0]!);
    const budget = createBudget({ maxGenerations: 1, maxCostUsd: 1 });
    const fetch = vi.fn(async () => {
      if (status === 'timeout') throw Object.assign(new Error('Never log this'), { name: 'TimeoutError' });
      return { ok: false, status: status as number, headers: new Headers(), text: async () => '{}' };
    });
    await attemptGeneration(prepared, { budget, apiKey: 'unit-only-key', fetch });
    expect(budget.attempts).toBe(1);
    expect(budget.unknownReservedUsd).toBeGreaterThan(0);
    await expect(attemptGeneration(prepared, { budget, apiKey: 'unit-only-key', fetch })).rejects.toThrow('Budget exhausted');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses an unaffordable request before POST without reading credentials during invalid setup', async () => {
    const prepared = loadVariant(null).prepare(fixtures[0]!);
    const fetch = vi.fn(), getKey = vi.fn();
    await expect(attemptGeneration(prepared, { budget: createBudget({ maxGenerations: 1, maxCostUsd: 0.000001 }),
      apiKey: 'unit-only-key', fetch })).rejects.toThrow('Budget exhausted');
    await expect(runComparison({ live: true, baselineRef: '1290e81', repetitions: 1, mode: 'fixed', maxGenerations: 1, maxCostUsd: NaN },
      { getKey, fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(getKey).not.toHaveBeenCalled();
  });

  it('rejects invalid usage cost and never assumes a failed attempt was free', () => {
    const budget = createBudget({ maxGenerations: 3, maxCostUsd: 1 });
    for (const cost of [null, -1, NaN]) {
      const receipt = budget.reserve('synthetic', 8192);
      budget.reconcile(receipt, cost);
    }
    expect(budget.knownCostUsd).toBe(0);
    expect(budget.unknownReservedUsd).toBeGreaterThan(0);
  });

  it('stops chain children after a failed parent instead of manufacturing history', async () => {
    const options = parseOptions(['--live', '--max-generations=20', '--max-cost-usd=1', '--explicit-known-pricing', '--mode=chain']);
    const fetch = vi.fn(async () => ({ ok: false, status: 400, headers: new Headers(), text: async () => '{}' }));
    const report = await runComparison(options, { getKey: () => 'unit-only-key', fetch });
    const child = report.pairs.find(pair => pair.caseId === 'reminder-time');
    expect(child!.results.baseline.reason).toBe('parent_failed');
    expect(child!.results.current.reason).toBe('parent_failed');
    expect(report.attempts).toBeLessThan(report.pairCount * 2);
  });

  it('accepts missing-time aliases and explicit date components, rejecting invented dates', () => {
    const variant = loadVariant(null);
    const fixture = fixtures.find(item => item.id === 'ampm-ambiguity')!;
    const wire = structuredClone(fixture.wire);
    wire.actions[0]!.missingFields = ['main_time'];
    expect(gradeDecision(fixture, variant.validate(JSON.stringify(wire), fixture)).passed).toBe(true);
    const dated = fixtures.find(item => item.id === 'dated-reminder')!;
    const bad = structuredClone(dated.wire);
    bad.actions[0]!.schedule!.year = 2027;
    expect(gradeDecision(dated, variant.validate(JSON.stringify(bad), dated)).passed).toBe(false);
  });

  it('checks task projection and owned targeting separately and refuses quoted side effects', () => {
    const variant = loadVariant(null);
    const task = fixtures.find(item => item.id === 'second-description')!;
    const bad = structuredClone(task.wire);
    bad.actions[0]!.query = 'First task';
    const grade = gradeDecision(task, variant.validate(JSON.stringify(bad), task));
    expect(grade.assertions.find(item => item.id === 'owned_target')!.passed).toBe(false);
    expect(grade.assertions.find(item => item.id === 'projection')!.passed).toBe(true);
    const quoted = fixtures.find(item => item.id === 'quoted-agenda')!;
    expect(gradeDecision(quoted, { valid: true, intent: { actions: [{ domain: 'entity', action: 'delete', scope: 'all' }] } }).passed).toBe(false);
  });

  it('retains full owned row projections and rejects nonexistent notes or illegal task-list contextRef', () => {
    const variant = loadVariant(null), fixture = fixtures.find(item => item.id === 'full-projection')!;
    const grade = gradeDecision(fixture, variant.prepare(fixture).validation);
    expect(grade.simulatedReceipt.effects[0]!.projection).toEqual([
      { id: '11111111-1111-4111-8111-111111111111', status: 'pending', description: 'First owned description' },
      { id: '22222222-2222-4222-8222-222222222222', status: 'pending', description: 'Second owned description' },
    ]);
    for (const change of [{ returnFields: ['notes'] }, { contextRef: { source: 'working_memory', position: 2 } }]) {
      const bad = structuredClone(fixture.wire);
      Object.assign(bad.actions[0]!, change);
      expect(variant.validate(JSON.stringify(bad), fixture).valid).toBe(false);
    }
    const duplicate = structuredClone(fixture.wire);
    duplicate.actions.push(structuredClone(duplicate.actions[0]!));
    expect(gradeDecision(fixture, variant.validate(JSON.stringify(duplicate), fixture)).passed).toBe(false);
  });

  it('grades lasting language, dog fact and task read independently without demanding a redundant language save', () => {
    const variant = loadVariant(null), fixture = fixtures.find(item => item.id === 'lasting-language-and-fact')!;
    for (const [field, assertion] of [['profileUpdate', 'durable_language'], ['learningCandidates', 'independent_dog_fact'], ['actions', 'independent_task_read']]) {
      const wire = structuredClone(fixture.wire);
      if (field === 'actions') wire.actions = [{ operation: 'conversation.reply', content: 'Okay.' }];
      else if (field === 'learningCandidates') wire.learningCandidates = [];
      else delete wire.profileUpdate;
      expect(gradeDecision(fixture, variant.validate(JSON.stringify(wire), fixture)).assertions.find(item => item.id === assertion)!.passed).toBe(false);
    }
    const saved = { ...fixture, context: { ...fixture.context, language: 'en', profileLanguage: 'en' } };
    const wire = structuredClone(saved.wire);
    delete wire.profileUpdate;
    expect(gradeDecision(saved, variant.validate(JSON.stringify(wire), saved)).passed).toBe(true);
  });

  it('requires a genuine capped ledger and rejects a mismatched body before transport', async () => {
    const prepared = loadVariant(null).prepare(fixtures[0]!), fetch = vi.fn();
    await expect(attemptGeneration(prepared, { budget: { reserve: () => ({}) } as unknown as ReturnType<typeof createBudget>, apiKey: 'unit-only-key', fetch })).rejects.toThrow();
    await expect(attemptGeneration({ ...prepared, serializedBody: '{}' }, {
      budget: createBudget({ maxGenerations: 1, maxCostUsd: 1 }), apiKey: 'unit-only-key', fetch,
    })).rejects.toThrow('Unsafe evaluation route');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('marks divergent valid parent drafts unmatched and excludes fast semantic failures from latency samples', async () => {
    let count = 0;
    const variant = loadVariant(null);
    const options = parseOptions(['--live', '--mode=chain', '--pairs=4', '--max-generations=8', '--max-cost-usd=1', '--explicit-known-pricing']);
    const report = await runComparison(options, { getKey: () => 'unit-only-key', fetch: async () => {
      const fixture = fixtures[Math.floor(count / 2)]!;
      const prepared = variant.prepare(fixture);
      const wire = structuredClone(prepared.fixtureWire);
      if (fixture.id === 'missing-time' && count % 2) wire.actions[0]!.question = 'Synthetic alternate question';
      if (fixture.id === 'greeting') { wire.actions[0]!.operation = 'entity.delete'; wire.actions[0]!.scope = 'all'; }
      count++;
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ provider: 'Groq', choices: [
        { finish_reason: 'stop', message: { content: JSON.stringify(wire) } },
      ] }) };
    } });
    const child = report.pairs.find(pair => pair.caseId === 'reminder-time');
    expect(child!.matched).toBe(false);
    expect(child!.bytes.saved).toBeNull();
    expect(child!.nativePromptTokenDelta).toBeNull();
    expect(report.nativeUsage!.current.failureReasons.semantic_failure).toBe(1);
    expect(report.nativeUsage!.current.acceptedLatencySampleCount).toBe(3);
    expect(report.cost!.unknownReservedUsd).toBeGreaterThan(0);
  });

  it('retains allowlisted synthetic decision fields without freeform prose or secret strings', () => {
    const safe = safeDecision({ actions: [{ domain: 'task', action: 'list', query: 'Second task',
      returnFields: ['description'], content: 'unit-only-key', target: 'unit-only-key' }] }, fixtures.find(f => f.id === 'second-description')!, 'unit-only-key');
    expect(safe.actions[0]!.query).toBe('Second task');
    expect(safe.actions[0]!.returnFields).toEqual(['description']);
    expect(JSON.stringify(safe)).not.toContain('unit-only-key');
    const derived = structuredClone(fixtures[0]!);
    derived.activeRun = { payload: { content: 'model-invented-private-string' } } as unknown as NonNullable<EvaluationFixture['activeRun']>;
    expect(safeDecision({ actions: [{ domain: 'conversation', action: 'reply', content: 'model-invented-private-string' }] }, derived)
      .actions[0]!.content).toBe('[unrecognized]');
  });
});

describe('typed contract evaluator boundaries', () => {
  it('hashes the actual TypeScript candidate contract in policy provenance', () => {
    const path = 'src/agent/contracts/learning-candidates-contract.ts';
    const current = loadVariant(null);
    expect(current.hashes[path]).toBe(hash(readFileSync(new URL('../../../' + path, import.meta.url), 'utf8')));
    const altered = loadVariant(null, { readSource: requested => {
      const source = readFileSync(new URL('../../../' + requested, import.meta.url), 'utf8');
      return requested === path ? source.replace('export interface LearningCandidate', '// provenance fixture\nexport interface LearningCandidate') : source;
    } });
    expect(altered.policyVersion).not.toBe(current.policyVersion);
  });
  it('rejects an effect-owning import in a typed contract or its facade', () => {
    for (const path of ['src/agent/contracts/schema-value-contract.ts', 'src/agent/contracts/schema-value.ts']) {
      expect(() => loadVariant(null, { readSource: requested => {
        const source = readFileSync(new URL('../../../' + requested, import.meta.url), 'utf8');
        return requested === path ? source + "\nimport { saveMemory } from '../../infrastructure/database/memories.js';\n" : source;
      } })).toThrow('Denied import');
    }
  });
});


describe('typed scope helper policy provenance', () => {
  it('hashes both the compatibility entry and actual typed helper source as read-only policy', () => {
    const variant = loadVariant(null);
    for (const path of ['src/shared/agenda-scopes.ts', 'src/shared/read-scope-normalization.ts']) {
      expect(variant.provenance.find(file => file.path === path)).toMatchObject({
        hash: hash(readFileSync(new URL('../../../' + path, import.meta.url), 'utf8')),
        role: 'scope_helpers_read_only',
      });
    }
  });
  it('records changed helper policy without evaluating unused effect-owning imports or code', () => {
    const current = loadVariant(null);
    const path = 'src/shared/read-scope-normalization.ts';
    const altered = loadVariant(null, { readSource: requested => {
      const source = readFileSync(new URL('../../../' + requested, import.meta.url), 'utf8');
      return requested === path ? "import { saveMemory } from '../infrastructure/database/memories.js';\nthrow new Error('Read-only policy must never execute');\n" + source : source;
    } });
    expect(altered.policyVersion).not.toBe(current.policyVersion);
    expect(altered.provenance.find(file => file.path === path)!.role).toBe('scope_helpers_read_only');
  });
});

describe('typed request payload evaluator boundary', () => {
  it('records the actual pure TypeScript source used to build wire requests', () => {
    const path = 'src/agent/providers/gateway-request-payload.ts';
    expect(loadVariant(null).hashes[path]).toBe(hash(readFileSync(new URL('../../../' + path, import.meta.url), 'utf8')));
  });
  it('denies effect imports added to the typed request constructor', () => {
    expect(() => loadVariant(null, { readSource: path => {
      const source = readFileSync(new URL('../../../' + path, import.meta.url), 'utf8');
      return path === 'src/agent/providers/gateway-request-payload.ts'
        ? source + "\nimport { getActiveRunFromDb } from '../../infrastructure/database/agent-runs.js';\n" : source;
    } })).toThrow('Denied import');
  });
});

describe('typed router history evaluator boundary', () => {
  it('hashes the actual pure typed context implementation', () => {
    const path = 'src/agent/orchestration/router-model-context.ts';
    expect(loadVariant(null).hashes[path]).toBe(hash(readFileSync(new URL('../../../' + path, import.meta.url), 'utf8')));
  });
  it('denies storage imports added to the context implementation', () => {
    expect(() => loadVariant(null, { readSource: path => {
      const source = readFileSync(new URL('../../../' + path, import.meta.url), 'utf8');
      return path === 'src/agent/orchestration/router-model-context.ts'
        ? source + "\nimport { getActiveRunFromDb } from '../../infrastructure/database/agent-runs.js';\n" : source;
    } })).toThrow('Denied import');
  });
});

describe('typed agent prompt evaluator boundary', () => {
  it('hashes the actual prompt factory used with explicit synthetic adapters', () => {
    const path = 'src/agent/core/agent-prompt.ts';
    expect(loadVariant(null).hashes[path]).toBe(hash(readFileSync(new URL('../../../' + path, import.meta.url), 'utf8')));
  });
  it('denies storage imports added to the prompt factory', () => {
    expect(() => loadVariant(null, { readSource: path => {
      const source = readFileSync(new URL('../../../' + path, import.meta.url), 'utf8');
      return path === 'src/agent/core/agent-prompt.ts'
        ? source + "\nimport { getActiveRunFromDb } from '../../infrastructure/database/agent-runs.js';\n" : source;
    } })).toThrow('Denied import');
  });
});
