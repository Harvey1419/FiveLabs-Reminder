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
 *   node scripts/evals/llm-eval.js --scenario=missing-time
 */

import { performance } from 'node:perf_hooks';
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

export function completeFixtureWire(value, schema) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(item => completeFixtureWire(item, schema?.items));
  if (value && typeof value === 'object' && schema?.properties) {
    const completed = {};
    for (const key of schema.required || []) {
      completed[key] = value[key] === undefined ? null : completeFixtureWire(value[key], schema.properties[key]);
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
const MODEL_PRICING = {
  'openai/gpt-oss-120b': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  'meta-llama/llama-3.3-70b-instruct': { inputPerMillion: 0.12, outputPerMillion: 0.30 },
  'llama-3.3-70b-versatile': { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  'z-ai/glm-5.3-flash': { inputPerMillion: 0.10, outputPerMillion: 0.10 },
  'default_safe_ceiling': { inputPerMillion: 1.00, outputPerMillion: 3.00 },
};

function resolveModelPricing(model) {
  return MODEL_PRICING[model] || MODEL_PRICING['default_safe_ceiling'];
}

const PROVIDER_CONFIGS = {
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

function parseArgs(args) {
  const options = {
    live: false,
    smoke: false,
    provider: 'openrouter',
    model: null,
    scenario: null,
    budget: 0.15,
    help: false,
  };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--live') options.live = true;
    else if (arg === '--smoke') options.smoke = true;
    else if (arg.startsWith('--provider=')) options.provider = arg.split('=')[1].toLowerCase();
    else if (arg.startsWith('--model=')) options.model = arg.split('=')[1];
    else if (arg.startsWith('--scenario=')) options.scenario = arg.split('=')[1];
    else if (arg.startsWith('--budget=')) {
      const parsed = parseFloat(arg.split('=')[1]);
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
    options.model = PROVIDER_CONFIGS[options.provider].defaultModel;
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
  node scripts/evals/llm-eval.js --scenario=missing-time
`);
}

function formatTable(rows) {
  if (rows.length === 0) return '';
  const headers = ['Scenario', 'Latency', 'Tokens (in/out)', 'Schema', 'Grade', 'Details'];
  const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] || '').length)));

  const pad = (str, width) => String(str || '').padEnd(width);
  const headerLine = headers.map((h, i) => pad(h, colWidths[i])).join(' | ');
  const sepLine = colWidths.map(w => '-'.repeat(w)).join('-+-');

  const contentLines = rows.map(r => r.map((c, i) => pad(c, colWidths[i])).join(' | '));
  return [headerLine, sepLine, ...contentLines].join('\n');
}

async function runScenario(fixture, options, state) {
  let schema;
  let schemaName;
  const maxTokens = fixture.phase === 'initial' ? 4096 : 2048;

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
    prompt += `\n\n${formatActiveRunPrompt(fixture.activeRun)}`;
  }

  const messages = [
    { role: 'system', content: prompt },
    ...(fixture.history || []),
    { role: 'user', content: fixture.text },
  ];

  let rawDecision = null;
  let latencyStr = '';
  let latencyMs = 0;
  let tokensIn = 0;
  let tokensOut = 0;

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
    try {
      response = await fetch(config.endpoint, {
        method: 'POST',
        headers: config.buildHeaders(apiKey),
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // Account for failed attempt cost
      state.totalCostUsd += (estimatedPromptTokens * pricing.inputPerMillion) / 1e6;
      throw err;
    }

    latencyMs = Math.round(performance.now() - start);
    latencyStr = `${latencyMs}ms`;

    if (!response.ok) {
      state.totalCostUsd += (estimatedPromptTokens * pricing.inputPerMillion) / 1e6;
      const errText = await response.text();
      return {
        id: fixture.id,
        latencyMs,
        latencyStr,
        tokensIn: estimatedPromptTokens,
        tokensOut: 0,
        schemaValid: false,
        passed: false,
        details: `HTTP ${response.status}: ${errText.slice(0, 80)}`,
      };
    }

    const resJson = await response.json();
    const choice = resJson.choices?.[0];
    const content = choice?.message?.content;

    // Settle actual cost with fallback estimation if usage is omitted
    tokensIn = resJson.usage?.prompt_tokens ?? estimatedPromptTokens;
    tokensOut = resJson.usage?.completion_tokens ?? Math.max(1, Math.ceil(String(content || '').length / 3.5));
    const actualCost = ((tokensIn * pricing.inputPerMillion) + (tokensOut * pricing.outputPerMillion)) / 1e6;
    state.totalCostUsd += actualCost;

    try {
      rawDecision = typeof content === 'string' ? JSON.parse(content) : content;
    } catch {
      return {
        id: fixture.id,
        latencyMs,
        latencyStr,
        tokensIn,
        tokensOut,
        schemaValid: false,
        passed: false,
        details: 'Invalid JSON output from model',
      };
    }
  } else {
    // Smoke / Offline mode: Use wire fixture decision completed against schema
    rawDecision = completeFixtureWire(fixture.wire, schema);
    latencyStr = 'synthetic';
  }

  let validation;
  if (fixture.phase === 'approval') {
    validation = validateApprovalDecision(rawDecision);
  } else if (fixture.phase === 'continuation') {
    validation = validateContinuationDecision(rawDecision);
  } else {
    validation = validateForegroundContent(rawDecision, { isAdmin: false, currentUserText: fixture.text });
  }

  const grade = gradeDecision(fixture, validation);

  const failedAssertion = grade.assertions.find(a => !a.passed);
  const details = grade.passed ? 'All semantic assertions met' : (failedAssertion ? `${failedAssertion.id}: ${failedAssertion.reason}` : 'Failed');

  return {
    id: fixture.id,
    latencyMs,
    latencyStr,
    tokensIn,
    tokensOut,
    schemaValid: validation.valid,
    passed: grade.passed,
    details,
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
  const results = [];
  const tableRows = [];

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
        details: err.message,
      });
      tableRows.push([
        fixture.id,
        '0ms',
        '0/0',
        '✗',
        'ERR',
        err.message.slice(0, 50),
      ]);
      if (err.message.includes('Budget cap')) break;
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
  console.log(`\n======================================================\n`);

  process.exit(totalPassed === results.length ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal evaluation runner error:', err);
  process.exit(1);
});
