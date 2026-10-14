#!/usr/bin/env node

/**
 * Hermes Canonical LLM Evaluation Runner
 *
 * Provides fast, reliable, model-agnostic semantic evaluations for any incoming LLM.
 * Evaluates TurnIntent schema compliance, temporal schedule resolution, language preservation,
 * and semantic reasoning without ad-hoc temporary test scaffolding.
 *
 * Usage:
 *   npm run eval:smoke
 *   npm run eval:live -- --model=openai/gpt-oss-120b
 *   npm run eval:live -- --provider=groq --model=llama-3.3-70b-versatile
 *   node --import tsx scripts/evals/llm-eval.ts --scenario=missing-time
 */

import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fixtures } from './groq-contract/fixtures.js';
import { gradeDecision } from './groq-contract/grader.js';
import { validateForegroundContent } from '../../src/agent/contracts/foreground-turn-validation.js';
import {
  APPROVAL_DECISION_SCHEMA,
  CONTINUATION_DECISION_SCHEMA,
  validateApprovalDecision,
  validateContinuationDecision,
} from '../../src/agent/contracts/agent-run-contracts.js';
import { getStructuredTurnSchema } from '../../src/agent/contracts/foreground-turn-schema.js';
import { buildAgentCorePrompt } from '../../src/agent/core/agent-core.js';
import { formatActiveRunPrompt } from '../../src/agent/core/agent-run.js';

import type { EvaluationFixture, EvaluationValidation } from './groq-contract/fixtures.js';
type SchemaNode = { items?: SchemaNode; properties?: Record<string, SchemaNode>; required?: readonly string[] };
type Options = { live: boolean; smoke: boolean; provider: string; model: string | null; scenario: string | null; output: string | null; budget: number; help: boolean };
type Pricing = { inputPerMillion: number; outputPerMillion: number };
type ProviderInput = { model: string | null; messages: { role: string; content: string }[]; schema: unknown; schemaName: string; maxTokens: number };
type ProviderConfig = { endpoint: string; envKey: string; defaultModel: string; buildHeaders(apiKey: string): Record<string, string>; buildBody(input: ProviderInput): unknown };
type ProviderReply = { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
type ValidationView = EvaluationValidation & { errors?: unknown; error?: string };
type FailureResult = { id: string; latencyMs: number; latencyStr: string; tokensIn: number; tokensOut: number; schemaValid: boolean; passed: boolean; details: string; deadlineMet?: boolean };

export function completeFixtureWire(value: unknown, schema?: SchemaNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(item => completeFixtureWire(item, schema?.items));
  if (value && typeof value === 'object' && schema?.properties) {
    const completed: Record<string, unknown> = {};
    for (const key of schema.required || []) {
      completed[key] = (value as Record<string, unknown>)[key] === undefined ? null : completeFixtureWire((value as Record<string, unknown>)[key], schema.properties[key]);
    }
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(completed, key) && item !== undefined) {
        completed[key] = schema.properties[key] ? completeFixtureWire(item, schema.properties[key]) : item;
      }
    }
    return completed;
  }
  return value;
}

// Known model pricing per million tokens; unknown models use conservative safe ceiling
const MODEL_PRICING: Record<string, Pricing> = {
  'openai/gpt-oss-120b': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  'meta-llama/llama-3.3-70b-instruct': { inputPerMillion: 0.12, outputPerMillion: 0.30 },
  'llama-3.3-70b-versatile': { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  'z-ai/glm-5.3-flash': { inputPerMillion: 0.10, outputPerMillion: 0.10 },
  'default_safe_ceiling': { inputPerMillion: 1.00, outputPerMillion: 3.00 },
};

function resolveModelPricing(model: string | null) {
  return MODEL_PRICING[model!] || MODEL_PRICING['default_safe_ceiling']!;
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  openrouter: {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    envKey: 'OPENROUTER_API_KEY',
    defaultModel: 'openai/gpt-oss-120b',
    buildHeaders(apiKey) {
      return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://fivelabs.co',
        'X-Title': 'Hermes Canonical LLM Evaluation',
      };
    },
    buildBody({ model, messages, schema, schemaName, maxTokens }) {
      return {
        model,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
        reasoning: { effort: 'medium', exclude: true },
        provider: {
          order: ['groq'],
          only: ['groq'],
          allow_fallbacks: false,
          require_parameters: true,
        },
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: schemaName,
            strict: true,
            schema,
          },
        },
      };
    },
  },
  groq: {
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    envKey: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
    buildHeaders(apiKey) {
      return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      };
    },
    buildBody({ model, messages, maxTokens }) {
      return {
        model,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
        response_format: {
          type: 'json_object',
        },
      };
    },
  },
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    envKey: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini',
    buildHeaders(apiKey) {
      return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      };
    },
    buildBody({ model, messages, schema, schemaName, maxTokens }) {
      return {
        model,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: schemaName,
            strict: true,
            schema,
          },
        },
      };
    },
  },
};

function parseArgs(args: string[]) {
  const options: Options = {
    live: false,
    smoke: false,
    provider: 'openrouter',
    model: null,
    scenario: null,
    output: null,
    budget: 0.15,
    help: false,
  };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--live') options.live = true;
    else if (arg === '--smoke') options.smoke = true;
    else if (arg.startsWith('--provider=')) options.provider = arg.split('=')[1]!.toLowerCase();
    else if (arg.startsWith('--model=')) options.model = arg.split('=')[1]!;
    else if (arg.startsWith('--scenario=')) options.scenario = arg.split('=')[1]!;
    else if (arg.startsWith('--output=')) options.output = arg.split('=')[1]!;
    else if (arg.startsWith('--budget=')) {
      const parsed = parseFloat(arg.split('=')[1]!);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10) {
        throw new Error('Invalid --budget: must be a positive finite number up to 10.00 USD');
      }
      options.budget = parsed;
    }
  }

  if (!Number.isFinite(options.budget) || options.budget <= 0) {
    throw new Error('Invalid budget configuration');
  }

  if (!options.model && PROVIDER_CONFIGS[options.provider]) {
    options.model = PROVIDER_CONFIGS[options.provider]!.defaultModel;
  }

  return options;
}

function printHelp() {
  console.log(`
Hermes Canonical LLM Evaluation Harness

Options:
  --smoke              Run fast offline contract and grading verification (< 1s)
  --live               Execute live HTTP API calls to the target LLM
  --provider=<name>    LLM provider: openrouter (default), groq, openai
  --model=<id>         Model identifier (e.g. openai/gpt-oss-120b, llama-3.3-70b-versatile)
  --scenario=<id>      Execute a single scenario (e.g. --scenario=missing-time)
  --budget=<usd>       Maximum budget in USD before halting (default: $0.15)
  --help, -h           Show this help message

Examples:
  npm run eval:smoke
  npm run eval:live -- --model=openai/gpt-oss-120b
  npm run eval:live -- --provider=groq --model=llama-3.3-70b-versatile
  node --import tsx scripts/evals/llm-eval.ts --scenario=missing-time
`);
}

function formatTable(rows: string[][]) {
  if (rows.length === 0) return '';
  const headers = ['Scenario', 'Latency', 'Tokens (in/out)', 'Schema', 'Grade', 'Details'];
  const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] || '').length)));

  const pad = (str: unknown, width: number) => String(str || '').padEnd(width);
  const headerLine = headers.map((h, i) => pad(h, colWidths[i]!)).join(' | ');
  const sepLine = colWidths.map(w => '-'.repeat(w)).join('-+-');

  const contentLines = rows.map(r => r.map((c, i) => pad(c, colWidths[i]!)).join(' | '));
  return [headerLine, sepLine, ...contentLines].join('\n');
}

async function runScenario(fixture: EvaluationFixture, options: Options, state: { totalCostUsd: number }) {
  let schema;
  let schemaName;
  const maxTokens = fixture.phase === 'initial' ? 8192 : 4096;

  if (fixture.phase === 'approval') {
    schema = APPROVAL_DECISION_SCHEMA;
    schemaName = 'hermes_approval_decision';
  } else if (fixture.phase === 'continuation') {
    schema = CONTINUATION_DECISION_SCHEMA;
    schemaName = 'hermes_continuation_decision';
  } else {
    schema = getStructuredTurnSchema({ isAdmin: false, attachmentOnly: false });
    schemaName = 'hermes_turn_intent';
  }

  let prompt = buildAgentCorePrompt({
    nowStr: fixture.context.nowStr,
    nowHumanStr: fixture.context.nowHumanStr,
    timezone: fixture.context.timezone,
    phoneNumber: fixture.owner,
    memoryHints: fixture.context.memoryHints || '',
    preferenceHints: fixture.context.preferenceHints || '',
    overview: fixture.context.overview || {},
    workingMemoryText: fixture.context.workingMemoryText || '',
    googleIntegration: fixture.context.googleIntegration || {},
    isAdmin: false,
    isPro: Boolean(fixture.context.isPro),
    displayName: fixture.context.displayName || 'Test Owner',
    inputModality: 'text',
    userMessage: fixture.text,
    language: fixture.context.language || 'es',
    memoryRetrievalStatus: 'loaded',
  });

  if (fixture.activeRun) {
    prompt += `\n\n${formatActiveRunPrompt(fixture.activeRun as unknown as Parameters<typeof formatActiveRunPrompt>[0])}`;
  }

  const messages = [
    { role: 'system', content: prompt },
    ...(fixture.history || []),
    { role: 'user', content: fixture.text },
  ];

  let rawDecision: unknown = null;
  let latencyStr = '';
  let latencyMs = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let attemptsUsed = 1;

  if (options.live) {
    const config = PROVIDER_CONFIGS[options.provider];
    if (!config) throw new Error(`Unknown provider: ${options.provider}`);

    const apiKey = process.env[config.envKey];
    if (!apiKey) {
      throw new Error(`Missing ${config.envKey} environment variable for provider ${options.provider}.`);
    }

    const pricing = resolveModelPricing(options.model);
    const estimatedPromptTokens = Math.max(10, Math.ceil(JSON.stringify(messages).length / 3.5));
    const potentialMaxCost = ((estimatedPromptTokens * pricing.inputPerMillion) + (maxTokens * pricing.outputPerMillion)) / 1e6;

    // Strict pre-call budget reservation
    if (state.totalCostUsd + potentialMaxCost > options.budget) {
      throw new Error(`Budget cap would be exceeded: current $${state.totalCostUsd.toFixed(4)} + reservation $${potentialMaxCost.toFixed(4)} > cap $${options.budget.toFixed(2)}.`);
    }

    const payload = config.buildBody({
      model: options.model,
      messages,
      schema,
      schemaName,
      maxTokens,
    });

    const start = performance.now();
    let response;
    let resJson: ProviderReply | undefined;
    let choice;
    let content: unknown;

    let failedAttemptsCost = 0;
    attemptsUsed = 1;

    for (let attempt = 0; attempt < 4; attempt++) {
      attemptsUsed = attempt + 1;
      const reservationCost = potentialMaxCost;
      if (state.totalCostUsd + failedAttemptsCost + reservationCost > options.budget) {
        state.totalCostUsd += failedAttemptsCost;
        throw new Error(`Budget cap would be exceeded on attempt ${attemptsUsed}: current $${(state.totalCostUsd + failedAttemptsCost).toFixed(4)} + pending $${reservationCost.toFixed(4)} > cap $${options.budget.toFixed(2)}.`);
      }
      try {
        response = await fetch(config.endpoint, {
          method: 'POST',
          headers: config.buildHeaders(apiKey),
          body: JSON.stringify(payload),
        });
        if (response.ok) {
          resJson = await response.json() as ProviderReply;
          choice = resJson.choices?.[0];
          content = choice?.message?.content;
          if (typeof content === 'string' && content.trim().length > 0) break;
        }
        failedAttemptsCost += potentialMaxCost;
      } catch (err) {
        failedAttemptsCost += potentialMaxCost;
        if (attempt === 3) {
          state.totalCostUsd += failedAttemptsCost;
          throw err;
        }
      }
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }

    latencyMs = Math.round(performance.now() - start);
    latencyStr = `${latencyMs}ms`;

    if (!response || !response.ok) {
      state.totalCostUsd += failedAttemptsCost;
      const errText = response ? await response.text() : 'No response';
      return {
        id: fixture.id,
        phase: fixture.phase || 'foreground',
        attempts: attemptsUsed,
        latencyMs,
        latencyStr,
        deadlineMet: false,
        tokensIn: estimatedPromptTokens,
        tokensOut: 0,
        schemaValid: false,
        validationErrors: [`HTTP ${response?.status || 500}: ${errText.slice(0, 80)}`],
        passed: false,
        details: `HTTP ${response?.status || 500}: ${errText.slice(0, 80)}`,
        rawDecision: null,
        normalizedDecision: null,
        assertions: [],
      };
    }

    if (!content || typeof content !== 'string' || !content.trim()) {
      state.totalCostUsd += failedAttemptsCost;
      return {
        id: fixture.id,
        phase: fixture.phase || 'foreground',
        attempts: attemptsUsed,
        latencyMs,
        latencyStr,
        deadlineMet: false,
        tokensIn: estimatedPromptTokens,
        tokensOut: 0,
        schemaValid: false,
        validationErrors: ['Empty completion from provider after retries'],
        passed: false,
        details: 'Empty completion from provider after retries',
        rawDecision: null,
        normalizedDecision: null,
        assertions: [],
      };
    }

    // Settle actual cost with fallback estimation if usage is omitted
    tokensIn = resJson!.usage?.prompt_tokens ?? estimatedPromptTokens;
    tokensOut = resJson!.usage?.completion_tokens ?? Math.max(1, Math.ceil(String(content || '').length / 3.5));
    const actualCost = ((tokensIn * pricing.inputPerMillion) + (tokensOut * pricing.outputPerMillion)) / 1e6;
    state.totalCostUsd += actualCost + failedAttemptsCost;

    try {
      rawDecision = typeof content === 'string' ? JSON.parse(content) : content;
    } catch {
      return {
        id: fixture.id,
        phase: fixture.phase || 'foreground',
        attempts: attemptsUsed,
        latencyMs,
        latencyStr,
        deadlineMet: false,
        tokensIn,
        tokensOut,
        schemaValid: false,
        validationErrors: ['Invalid JSON output from model'],
        passed: false,
        details: 'Invalid JSON output from model',
        rawDecision: null,
        normalizedDecision: null,
        assertions: [],
      };
    }
  } else {
    // Smoke / Offline mode: Use wire fixture decision completed against schema
    rawDecision = completeFixtureWire(fixture.wire, schema);
    latencyStr = 'synthetic';
  }

  let validation: ValidationView;
  if (fixture.phase === 'approval') {
    validation = validateApprovalDecision(rawDecision) as unknown as ValidationView;
  } else if (fixture.phase === 'continuation') {
    validation = validateContinuationDecision(rawDecision) as unknown as ValidationView;
  } else {
    validation = validateForegroundContent(rawDecision, { isAdmin: false, currentUserText: fixture.text }) as unknown as ValidationView;
  }

  if (!validation.valid) {
    console.log(`\n[VALIDATION FAIL: ${fixture.id}]:`, JSON.stringify(validation.errors), 'RAW:', JSON.stringify((rawDecision as { actions?: unknown } | null)?.actions));
  }

  const grade = gradeDecision(fixture, validation);

  if (!grade.passed) {
    console.log(`\n[GRADE FAIL: ${fixture.id}]:`, grade.assertions.filter(a => !a.passed).map(a => `${a.id}: ${a.reason}`));
    console.log('[ACTIONS]:', JSON.stringify((rawDecision as { actions?: unknown } | null)?.actions));
  }

  const failedAssertion = grade.assertions.find(a => !a.passed);
  const details = grade.passed ? 'All semantic assertions met' : (failedAssertion ? `${failedAssertion.id}: ${failedAssertion.reason}` : 'Failed');
  const SLA_DEADLINE_MS = 10000;
  const deadlineMet = options.live ? latencyMs <= SLA_DEADLINE_MS : true;

  return {
    id: fixture.id,
    phase: fixture.phase || 'foreground',
    attempts: options.live ? (attemptsUsed || 1) : 1,
    latencyMs,
    latencyStr,
    deadlineMet,
    tokensIn,
    tokensOut,
    schemaValid: validation.valid,
    validationErrors: validation.valid ? null : (validation.errors || [validation.error || 'rejected_by_actual_validator']),
    passed: grade.passed,
    details,
    rawDecision,
    normalizedDecision: validation.valid ? (validation.intent || validation.decision || null) : null,
    assertions: grade.assertions,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const selectedFixtures = options.scenario
    ? fixtures.filter(f => f.id === options.scenario)
    : fixtures;

  if (selectedFixtures.length === 0) {
    console.error(`Scenario '${options.scenario}' not found. Available scenarios:`);
    fixtures.forEach(f => console.error(`  - ${f.id}`));
    process.exit(1);
  }

  console.log(`\n======================================================`);
  console.log(`Hermes Canonical LLM Evaluation Harness`);
  console.log(`Mode:      ${options.live ? 'LIVE API' : 'OFFLINE / SMOKE (Contract verification)'}`);
  if (options.live) {
    console.log(`Provider:  ${options.provider}`);
    console.log(`Model:     ${options.model}`);
    console.log(`Budget:    $${options.budget.toFixed(2)} USD cap`);
  }
  console.log(`Scenarios: ${selectedFixtures.length}`);
  console.log(`======================================================\n`);

  const state = { totalCostUsd: 0 };
  const results: (Awaited<ReturnType<typeof runScenario>> | FailureResult)[] = [];
  const tableRows: string[][] = [];

  for (const fixture of selectedFixtures) {
    process.stdout.write(`Evaluating [${fixture.id}]... `);
    try {
      const res = await runScenario(fixture, options, state);
      results.push(res);
      const statusIcon = res.passed ? 'PASS' : 'FAIL';
      console.log(res.passed ? '✓' : '✗');

      tableRows.push([
        res.id,
        res.latencyStr,
        options.live ? `${res.tokensIn}/${res.tokensOut}` : 'N/A',
        res.schemaValid ? '✓' : '✗',
        statusIcon,
        res.details,
      ]);
      if (options.live) await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log('ERROR');
      results.push({
        id: fixture.id,
        latencyMs: 0,
        latencyStr: '0ms',
        tokensIn: 0,
        tokensOut: 0,
        schemaValid: false,
        passed: false,
        details: (err as Error).message,
      });
      tableRows.push([
        fixture.id,
        '0ms',
        '0/0',
        '✗',
        'ERR',
        (err as Error).message.slice(0, 50),
      ]);
      if ((err as Error).message.includes('Budget cap')) break;
    }
  }

  console.log('\n' + formatTable(tableRows) + '\n');

  const totalPassed = results.filter(r => r.passed).length;
  const passRate = ((totalPassed / results.length) * 100).toFixed(1);
  const avgLatency = options.live && results.length > 0
    ? `${Math.round(results.reduce((acc, r) => acc + r.latencyMs, 0) / results.length)}ms`
    : 'N/A (offline)';

  console.log(`Summary:`);
  console.log(`  Passed:      ${totalPassed} / ${results.length} (${passRate}%)`);
  console.log(`  Avg Latency: ${avgLatency}`);
  if (options.live) {
    console.log(`  Total Cost:  $${state.totalCostUsd.toFixed(5)} USD`);
  }
  if (options.output) {
    mkdirSync(dirname(options.output), { recursive: true });
    const headCommit = (() => {
      try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      } catch {
        return 'UNKNOWN';
      }
    })();
    const sha256 = (filePath: string) => {
      try {
        return createHash('sha256').update(readFileSync(filePath, 'utf8')).digest('hex');
      } catch {
        return null;
      }
    };
    const provenanceHashes = {
      headCommit,
      agentCorePromptSha256: sha256('src/agent/core/agent-core.ts'),
      foregroundTurnSchemaSha256: sha256('src/agent/contracts/foreground-turn-schema.ts'),
      intentContractsSha256: sha256('src/agent/contracts/intent-contracts.ts'),
      fixturesSha256: sha256('scripts/evals/groq-contract/fixtures.ts'),
      graderSha256: sha256('scripts/evals/groq-contract/grader.ts'),
      evaluatorSha256: sha256('scripts/evals/llm-eval.ts'),
    };

    const latencies = options.live ? results.map(r => r.latencyMs).filter(n => Number.isFinite(n) && n > 0) : [];
    const sortedLatencies = [...latencies].sort((a, b) => a - b);
    const p95Latency = sortedLatencies.length ? sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] : null;
    const maxLatency = sortedLatencies.length ? sortedLatencies[sortedLatencies.length - 1] : null;
    const minLatency = sortedLatencies.length ? sortedLatencies[0] : null;

    writeFileSync(options.output, JSON.stringify({
      timestamp: new Date().toISOString(),
      mode: options.live ? 'live' : 'smoke',
      provider: options.provider,
      model: options.model,
      provenanceHashes,
      summary: {
        total: results.length,
        passed: totalPassed,
        passRate: `${passRate}%`,
        avgLatency,
        minLatencyMs: minLatency,
        maxLatencyMs: maxLatency,
        p95LatencyMs: p95Latency,
        deadlineSlaMetCount: results.filter(r => r.deadlineMet).length,
        deadlineSlaThresholdMs: 10000,
        totalCostUsd: options.live ? state.totalCostUsd : 0,
      },
      results,
    }, null, 2), 'utf8');
    console.log(`Saved evaluation report to ${options.output}\n`);
  }

  process.exit(totalPassed === results.length ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal evaluation runner error:', err);
  process.exit(1);
});
