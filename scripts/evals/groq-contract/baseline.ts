import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

import type { EvaluationFixture, EvaluationRun, EvaluationValidation } from './fixtures.js';
type ModuleExports = Record<string, unknown>;
type SchemaNode = { properties?: Record<string, SchemaNode>; items?: SchemaNode; required?: string[]; description?: string; [key: string]: unknown };
type Provenance = { path: string; origin: string; ref: string | null; hash: string; role: string };
const root = fileURLToPath(new URL('../../../', import.meta.url));
const PREFIX = 'src/agent/contracts/';
const typedContractNames = ['schema-value','turn-context','tool-names','response-policy','learning-candidates'];
const typedContractSources = new Map(typedContractNames.map(name => [PREFIX+name+'-contract.js',PREFIX+name+'-contract.ts']));
const contractFacades = new Map(typedContractNames.map(name => [PREFIX+name+'.js',{ target:`../../../dist/runtime/agent/contracts/${name}-contract.js`,source:PREFIX+name+'-contract.ts' }]));
contractFacades.set(PREFIX+'intent-contracts.js',{ target:'../../../dist/runtime/agent/contracts/intent-validator.js',source:PREFIX+'intent-validator.ts' });
contractFacades.set('src/shared/entity-categories.js',{ target:'../../dist/runtime/shared/entity-categories-contract.js',source:'src/shared/entity-categories-contract.ts' });
for (const [entry,target] of [['foreground-turn-schema','foreground-turn-projection'],['foreground-turn-validation','foreground-turn-validator']]) {
  contractFacades.set(PREFIX+entry+'.js',{ target:`../../../dist/runtime/agent/contracts/${target}.js`,source:PREFIX+target+'.ts' });
  typedContractSources.set(PREFIX+target+'.js',PREFIX+target+'.ts');
}
contractFacades.set(PREFIX+'agent-run-contracts.js',{ target:'../../../dist/runtime/agent/contracts/run-decision-contracts.js',source:PREFIX+'run-decision-contracts.ts' });
typedContractSources.set(PREFIX+'run-decision-contracts.js',PREFIX+'run-decision-contracts.ts');
typedContractSources.set(PREFIX+'intent-validator.js',PREFIX+'intent-validator.ts');
for (const name of ['agenda-scope-contract','entity-categories-contract','entity-reference-contract','calendar-lookup-date']) {
  typedContractSources.set(`src/shared/${name}.js`,`src/shared/${name}.ts`);
  typedContractSources.set(`dist/runtime/shared/${name}.js`,`src/shared/${name}.ts`);
}
contractFacades.set('src/shared/entity-resolution.js',{ target:'../../dist/runtime/shared/entity-matching.js',source:'src/shared/entity-matching.ts' });
typedContractSources.set('src/shared/entity-matching.js','src/shared/entity-matching.ts');
contractFacades.set('src/shared/agenda-scopes.js',{ target:'../../dist/runtime/shared/read-scope-normalization.js',source:'src/shared/read-scope-normalization.ts' });
typedContractSources.set('src/shared/read-scope-normalization.js','src/shared/read-scope-normalization.ts');
contractFacades.set('src/agent/providers/request-payload.js', { target: '../../../dist/runtime/agent/providers/gateway-request-payload.js', source: 'src/agent/providers/gateway-request-payload.ts' });
typedContractSources.set('src/agent/providers/gateway-request-payload.js', 'src/agent/providers/gateway-request-payload.ts');
contractFacades.set('src/agent/orchestration/router-context.js', { target: '../../../dist/runtime/agent/orchestration/router-model-context.js', source: 'src/agent/orchestration/router-model-context.ts' });
typedContractSources.set('src/agent/orchestration/router-model-context.js', 'src/agent/orchestration/router-model-context.ts');
typedContractSources.set('src/agent/core/agent-prompt.js', 'src/agent/core/agent-prompt.ts');
const trustedPromptFacade = "import { createAgentPrompt, AGENT_CONFIG } from './agent-prompt.js';\nimport { hasUsableGoogleCredentials } from '../../integrations/google/auth.js';\nimport { entityMatchScore, normalizeEntityName } from '../../infrastructure/database/entities.js';\nexport { AGENT_CONFIG };\nexport const { formatCompactOverview, formatReferencedProjectTasks, formatActiveFollowups, buildAgentCorePrompt } = createAgentPrompt({ hasUsableGoogleCredentials: hasUsableGoogleCredentials, entityMatchScore: entityMatchScore, normalizeEntityName: normalizeEntityName });";
const pureTypeScriptFiles = new Set(['src/agent/core/active-run-prompt.ts',...typedContractSources.values()]);
const pureFiles = new Set([
  'intent-contracts.js', 'turn-context.js', 'response-policy.js', 'tool-names.js',
  'schema-value.js', 'foreground-turn-schema.js', 'agent-run-contracts.js', 'foreground-turn-validation.js',
].map(name => PREFIX + name).concat([
  'src/agent/core/agent-core.js', 'src/agent/core/active-run-prompt.ts', 'src/agent/providers/request-payload.js',
  'src/shared/agenda-scopes.js', 'src/shared/entity-categories.js', 'src/shared/entity-resolution.js',
], [...typedContractSources.values()]));

export const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** Only local hexadecimal commit identities, never revisions/options/path expressions. */
export function validateBaselineRef(ref: unknown) {
  if (typeof ref !== 'string' || !/^[a-f0-9]{7,40}$/.test(ref)) throw new Error('Baseline must be a local hexadecimal commit identity');
  return ref;
}

/** Bounded adapter for this repository's static named imports/exports, not a JS parser.
 * Trusted repository commits ONLY. VM contexts are NOT security sandboxes.
 * Unknown imports and syntax are denied; dynamic imports are not supported.
 */
export function evaluateModule(source: string, resolveImport: (specifier: string) => ModuleExports, extra: ModuleExports = {}): ModuleExports {
  const bindings: ModuleExports = {};
  const transformed = source.replace(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm, (_line: string, names: string, specifier: string) => {
    const imported = resolveImport(specifier);
    for (const entry of names.split(',').map(name => name.trim()).filter(Boolean)) {
      const [name, alias = name] = entry.split(/\s+as\s+/);
      if (!Object.hasOwn(imported, name!)) throw new Error('Missing allowlisted import binding');
      bindings[alias!] = imported[name!];
    }
    return '';
  });
  // Reject unknown/default/namespace imports through the same deny-by-default resolver.
  const unknown = transformed.match(/^import\s+[\s\S]*?from\s*['"]([^'"]+)['"]/m);
  if (unknown) { resolveImport(unknown[1]!); throw new Error('Unsupported import form'); }
  if (/\bimport\s*\(/.test(transformed) || /^import\s/m.test(transformed)) throw new Error('Unsupported import form');
  const names = [...transformed.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/gm)].map(match => match[1]);
  const body = transformed.replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\s)/gm, '');
  if (/^export\s/m.test(body)) throw new Error('Unsupported export form');
  return runInNewContext(`(() => { ${body}\nreturn {${names.join(',')}}; })()`,
    { ...bindings, structuredClone, ...extra }, { timeout: 2000 });
}

function extractFunction(source: string, name: string) {
  const match = source.match(new RegExp(`(?:export )?function ${name}\\([^]*?\\n\\}`, 'm'));
  if (!match) throw new Error(`Trusted source boundary missing: ${name}`);
  return match[0]!.replace(/^export /, '');
}

/** Fill only required strict-wire fields from the actual provider schema. */
export function completeFixtureWire(value: unknown, schema: SchemaNode): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(item => completeFixtureWire(item, schema.items!));
  if (value && typeof value === 'object' && schema.properties) {
    const completed: Record<string, unknown> = {};
    for (const key of schema.required || []) completed[key] = (value as Record<string, unknown>)[key] === undefined ? null
      : completeFixtureWire((value as Record<string, unknown>)[key], schema.properties[key]!);
    for (const [key, item] of Object.entries(value)) if (!Object.hasOwn(completed, key) && item !== undefined) {
      completed[key] = schema.properties[key] ? completeFixtureWire(item, schema.properties[key]!) : item;
    }
    return completed;
  }
  return value;
}

function localCommit(ref: string | null) {
  const commit = execFileSync('git', ['rev-parse', '--verify', ref ? `${validateBaselineRef(ref)}^{commit}` : 'HEAD'],
    { cwd: root, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid local commit identity');
  return commit;
}

/** Test-only legacy parity adapter: exact historical wire statements, no client execution. */
export function loadLegacyRequestBuilder(ref: string) {
  const commit = localCommit(ref);
  if (!commit.startsWith('1290e81')) throw new Error('Unsupported legacy baseline layout');
  const client = execFileSync('git', ['show', `${commit}:src/agent/providers/client.js`], { cwd: root, encoding: 'utf8' });
  const start = client.indexOf('    const payload = { model, messages, temperature, max_tokens };');
  const end = client.indexOf('    const serializedBody = JSON.stringify(payload);', start);
  if (start < 0 || end < start) throw new Error('Trusted legacy payload boundary missing');
  return runInNewContext(`(function(messages, model, options) {
    const {temperature, max_tokens, responseFormat, tools, toolChoice, parallelToolCalls, reasoning,
      providers: requestedProviders, allowProviderFallbacks} = options;
    const strictForeground = responseFormat?.type === 'json_schema';
    ${client.slice(start, end)}
    return payload;
  })`);
}

function structuralSchema(value: unknown): SchemaNode {
  const node = structuredClone(value) as SchemaNode;
  delete node.description;
  if (node.properties) node.properties = Object.fromEntries(Object.entries(node.properties).map(([key, child]) => [key, structuralSchema(child)]));
  if (node.items) node.items = structuralSchema(node.items);
  return node;
}

export function loadVariant(ref: string | null, { readSource }: { readSource?: ((path: string) => string) | undefined } = {}) {
  const sourceCommit = localCommit(null);
  const baselineSchemaCommit = ref ? localCommit(ref) : null;
  if (ref && !baselineSchemaCommit!.startsWith('1290e81')) throw new Error('Unsupported baseline projection layout');
  const hashes: Record<string, string> = {}, provenance: Provenance[] = [], cache = new Map<string, ModuleExports>();
  function read(path: string) {
    if (path.startsWith('src/') && path.endsWith('.js')) path = path.slice(0, -3) + '.ts';
    const source = readSource ? readSource(path) : readFileSync(resolve(root, path), 'utf8');
    hashes[path] = hash(source);
    if (!provenance.some(file => file.path === path && file.origin === 'current_working_tree'))
      provenance.push({ path, origin: 'current_working_tree', ref: sourceCommit, hash: hashes[path]!, role: 'current_runtime' });
    return source;
  }
  function module(path: string): ModuleExports {
    if (path === 'src/agent/orchestration/personal-knowledge-core.js') return module('src/agent/orchestration/personal-knowledge.js');
    if (typedContractSources.has(path)) return module(typedContractSources.get(path)!);
    if (cache.has(path)) return cache.get(path)!;
    const facadeEntry = contractFacades.get(path);
    if (facadeEntry) {
      const source = stripTypeScriptTypes(read(path), { mode: 'strip' });
      const facade = /^export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?\s*$/.exec(source.trim());
      if (!facade || posix.normalize(posix.join(posix.dirname(path), facade[2]!)).replace(/\.js$/, '.ts') !== facadeEntry.source)
        throw new Error('Denied import');
      const exports = module(facadeEntry.source);
      const requested = facade[1]!.split(',').map(name => name.trim());
      if (requested.some(name => !Object.hasOwn(exports,name))) throw new Error('Denied import');
      const result = Object.fromEntries(requested.map(name => [name,exports[name]]));
      cache.set(path,result);
      return result;
    }
    if (path === 'src/agent/core/agent-core.js') {
      if (stripTypeScriptTypes(read(path), { mode: 'strip' }).replace(/\s/g, '') !== trustedPromptFacade.replace(/\s/g, '')) throw new Error('Denied prompt facade');
      const typed = module('src/agent/core/agent-prompt.ts') as unknown as typeof import('../../../src/agent/core/agent-prompt.js');
      const google = module('src/integrations/google/auth.js');
      const entities = module('src/infrastructure/database/entities.js');
      const result = { AGENT_CONFIG: typed.AGENT_CONFIG, ...typed.createAgentPrompt({
        hasUsableGoogleCredentials: google.hasUsableGoogleCredentials as Parameters<typeof typed.createAgentPrompt>[0]['hasUsableGoogleCredentials'],
        normalizeEntityName: entities.normalizeEntityName as Parameters<typeof typed.createAgentPrompt>[0]['normalizeEntityName'], entityMatchScore: entities.entityMatchScore as Parameters<typeof typed.createAgentPrompt>[0]['entityMatchScore'],
      }) };
      cache.set(path, result);
      return result;
    }
    // Explicit identical fixture adapters; never evaluate DB/Google modules.
    let adapter: ModuleExports | undefined;
    if (path === 'src/integrations/google/auth.js') adapter = { hasUsableGoogleCredentials: (integration: { syntheticConnected?: boolean } | null | undefined) => integration?.syntheticConnected === true };
    if (path === 'src/infrastructure/database/entities.js') adapter = {
      normalizeEntityName: (value: unknown) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(),
      entityMatchScore: (a: unknown, b: unknown) => a === b ? 1 : 0,
    };
    if (adapter) {
      provenance.push({ path: path.replace(/\.js$/, '.ts'), origin: 'synthetic_adapter', ref: 'fake-context-adapter-v1',
        hash: hash(Object.fromEntries(Object.entries(adapter).map(([name, fn]) => [name, String(fn)]))), role: 'fake_context_adapter' });
      cache.set(path, adapter);
      return adapter;
    }
    if (path === 'src/agent/orchestration/personal-knowledge.js') {
      read(path); // Keep facade provenance and extract only the allowlisted typed constant.
      const source = read('src/agent/orchestration/personal-knowledge-core.ts').match(/^export const PERSONAL_READ_OPERATIONS = [^\n]+/m)?.[0];
      if (!source) throw new Error('Trusted read-operation boundary missing');
      const result = evaluateModule(source, () => { throw new Error('Denied import'); });
      cache.set(path, result);
      return result;
    }
    if (!pureFiles.has(path)) throw new Error('Denied import');
    // Only explicitly allowlisted pure TS modules are stripped; source provenance hashes the original TS.
    const source = read(path);
    const result = evaluateModule(pureTypeScriptFiles.has(path)
      ? stripTypeScriptTypes(source, { mode: 'strip' }) : source, specifier => {
      if (!specifier.startsWith('.')) throw new Error('Denied import');
      return module(posix.normalize(posix.join(posix.dirname(path), specifier)));
    });
    cache.set(path, result);
    return result;
  }
  const contracts = module(PREFIX + 'intent-contracts.js') as unknown as typeof import('../../../src/agent/contracts/intent-validator.js');
  const schema = module(PREFIX + 'foreground-turn-schema.js') as unknown as typeof import('../../../src/agent/contracts/foreground-turn-projection.js');
  const phases = module(PREFIX + 'agent-run-contracts.js') as unknown as typeof import('../../../src/agent/contracts/run-decision-contracts.js');
  const { matchesSchema } = module(PREFIX + 'schema-value.js') as unknown as typeof import('../../../src/agent/contracts/schema-value-contract.js');
  const prompt = module('src/agent/core/agent-core.js') as unknown as typeof import('../../../src/agent/core/agent-core.js');
  const router = read('src/agent/orchestration/router-core.js');
  read('src/agent/providers/client.js');
  const { buildRequestPayload } = module('src/agent/providers/request-payload.js') as unknown as typeof import('../../../src/agent/providers/gateway-request-payload.js');
  const { validateForegroundContent } = module(PREFIX + 'foreground-turn-validation.js') as unknown as typeof import('../../../src/agent/contracts/foreground-turn-validator.js');
  let comparisonSchema = schema;
  if (ref) {
    const path = PREFIX + 'foreground-turn-schema.js';
    const source = execFileSync('git', ['show', `${baselineSchemaCommit}:${path}`], { cwd: root, encoding: 'utf8' });
    hashes[`baseline:${path}`] = hash(source);
    provenance.push({ path, origin: 'baseline_commit', ref: baselineSchemaCommit, hash: hash(source), role: 'comparison_schema' });
    comparisonSchema = evaluateModule(source, specifier => {
      if (specifier !== './intent-contracts.js') throw new Error('Denied baseline projection import');
      return contracts;
    }) as unknown as typeof schema;
  }
  if (hash(contracts.TURN_INTENT_SCHEMA) !== 'd306889ef8f2ea3d6d5f6aebda0aded590cb220748a2735581480b8f20fa1456')
    throw new Error('Canonical baseline identity changed');
  const fingerprints = ['c3d83bcb7cb544d3cec46e6054abb0393afd6864fec141c7576f15fe141862c5',
    '9a329279ac8234ebea74b7414ae1569b74dd7d145bf76500a091d5f45a3674d7',
    'db4891d517465f5cd7736f988eab819723a935272d240c9497e2f36087701eee',
    'db4891d517465f5cd7736f988eab819723a935272d240c9497e2f36087701eee'];
  [{}, { isAdmin: true }, { attachmentOnly: true }, { isAdmin: true, attachmentOnly: true }].forEach((options, index) => {
    if (hash(structuralSchema(comparisonSchema.getStructuredTurnSchema(options))) !== fingerprints[index]
      || hash(structuralSchema(schema.getStructuredTurnSchema(options))) !== fingerprints[index])
      throw new Error('Baseline provider structural identity changed');
  });
  const history = module('src/agent/orchestration/router-context.js') as unknown as typeof import('../../../src/agent/orchestration/router-model-context.js');
  const promptModule = module('src/agent/core/active-run-prompt.ts') as unknown as typeof import('../../../src/agent/core/active-run-prompt.js');
  const runPrompt = (activeRun: EvaluationRun) => promptModule.formatActiveRunPrompt(activeRun as unknown as Parameters<typeof promptModule.formatActiveRunPrompt>[0],
    phases.CONTINUATION_DECISION_SCHEMA.properties!.actionInputs!.items!.properties!.fields!.required!);
  // Provenance only: NEVER evaluate effect-owning modules or relocate their guards.
  const policyFiles = ['src/agent/contracts/response-policy.js', 'src/agent/core/agent-core.js',
    'src/agent/core/active-run-prompt.ts', 'src/agent/core/agent-run.js',
    'src/agent/orchestration/router-core.js', 'src/agent/orchestration/router-model-response.ts',
    'src/agent/orchestration/router-turn-decisions.ts', 'src/agent/orchestration/router-profile-context.ts',
    'src/agent/orchestration/router-context-reads.ts', 'src/agent/orchestration/router-prompt-preparation.ts', 'src/agent/orchestration/router-active-run.ts', 'src/agent/orchestration/router-foreground-decision.ts', 'src/agent/orchestration/router-action-preparation.ts', 'src/agent/orchestration/router-execution-boundary.ts', 'src/agent/orchestration/router-observed-reply.ts',
    'src/agent/orchestration/router-turn-lifecycle.ts', 'src/agent/orchestration/router-turn-initialization.ts', 'src/agent/orchestration/router-pipeline.ts', 'src/agent/orchestration/next-best-action-core.ts', 'src/agent/orchestration/clarification-state.ts', 'src/agent/orchestration/clarification-presentation-core.ts', 'src/agent/orchestration/observed-task-fields.ts', 'src/agent/orchestration/historical-evidence.ts', 'src/agent/orchestration/observed-answer-core.ts', 'src/agent/orchestration/router-assembly.ts', 'src/shared/current-user-input-policy.ts', 'src/shared/language-detection-policy.ts', 'src/shared/admin-policy.ts', 'src/shared/current-user-input.js', 'src/shared/auth.js', 'src/agent/tools/reminder-pro-context.ts', 'src/agent/tools/reminder-pro.js', 'src/integrations/google/google-auth.ts', 'src/infrastructure/database/subscription-policy.ts', 'src/infrastructure/database/subscription-persistence.ts', 'src/infrastructure/database/subscriptions.js', 'src/integrations/stripe/checkout-client.ts', 'src/integrations/stripe/client.js', 'src/infrastructure/database/database-client.ts', 'src/integrations/whatsapp/kapso-errors.ts', 'src/integrations/whatsapp/kapso-dispatch.ts', 'src/http/webhooks/billing-webhook-ports.ts', 'src/http/webhooks/stripe-handler.ts', 'src/http/webhooks/stripe.js', 'src/jobs/memory-extraction-queue.ts', 'src/jobs/memory-extractor.js', 'src/integrations/stripe/subscription-client.ts', 'src/features/calendar/watch-ports.ts', 'src/http/webhooks/user-webhook-queue.ts', 'src/http/webhooks/google-calendar-handler.ts', 'src/jobs/calendar-watch-renewal-core.ts', 'src/http/webhooks/google-calendar.js', 'src/jobs/calendar-watch-renewal.js', 'src/infrastructure/database/reminder-persistence-client.ts', 'src/infrastructure/database/reminder-persistence.ts', 'src/infrastructure/database/reminder-delivery-persistence.ts', 'src/infrastructure/database/reminder-overview.ts', 'src/infrastructure/database/index.js',
    'src/agent/orchestration/domain-call.js',
    'src/agent/orchestration/domain-call-builder.ts',
    'src/agent/orchestration/intent-normalizer.js', 'src/agent/orchestration/runtime-intent-normalizer.ts',
    'src/agent/orchestration/typed-schedule.js', 'src/agent/orchestration/temporal-schedule-resolver.ts',
    'src/shared/time.js', 'src/shared/timezone-arithmetic.ts', 'src/shared/calendar-query-bounds.ts',
    'src/shared/target-time-parser.ts', 'src/shared/date-time-presentation.ts',
    'src/shared/day-query-bounds.ts', 'src/shared/locale-timezone-inference.ts',
    'src/agent/core/working-memory-store.js', 'src/agent/core/working-memory-cache.ts',
    'src/agent/core/working-memory.js', 'src/agent/core/working-memory-acknowledgement.ts',
    'src/agent/core/working-memory-execution.js', 'src/agent/core/working-memory-outcomes.ts',
    'src/agent/providers/attempt-diagnostics.js', 'src/agent/providers/provider-attempt-diagnostics.ts',
    'src/agent/providers/response-synthesis-presentation.ts', 'src/agent/providers/gateway-routing.ts',
    'src/agent/providers/gateway-response-contracts.ts',
    'src/agent/providers/gateway-attempt.ts', 'src/agent/providers/gateway-chain.ts',
    'src/agent/providers/gateway-dispatch.ts', 'src/agent/providers/runner-provider-trace.ts',
    'src/agent/core/execution-facts.js', 'src/agent/core/execution-presentation.ts',
    'src/shared/agenda-scopes.js',
    'src/agent/core/presentation-policy.js', 'src/agent/core/turn-presentation-policy.ts', 'src/shared/presentation-design-tokens.ts',
    'src/shared/task-presentation.js', 'src/shared/task-card-presentation.ts',
    'src/shared/agenda-presentation.js', 'src/shared/agenda-card-presentation.ts',
    'src/shared/reminder-presentation.js', 'src/shared/reminder-card-presentation.ts',
    'src/shared/entity-presentation.js', 'src/shared/entity-card-presentation.ts',
    'src/agent/orchestration/intent-executor.js', 'src/agent/orchestration/turn-intent-executor.ts', 'src/shared/language-detection.js',
    ...typedContractSources.values()].map(path => path.startsWith('src/') ? path.replace(/\.js$/, '.ts') : path);
  for (const path of policyFiles) {
    if (!hashes[path]) read(path);
    if (path.includes('/orchestration/') || path.endsWith('language-detection.ts') || ['src/shared/current-user-input-policy.ts', 'src/shared/language-detection-policy.ts', 'src/shared/admin-policy.ts', 'src/shared/current-user-input.ts', 'src/shared/auth.ts', 'src/agent/tools/reminder-pro-context.ts', 'src/agent/tools/reminder-pro.ts', 'src/integrations/google/google-auth.ts', 'src/infrastructure/database/subscription-policy.ts', 'src/infrastructure/database/subscription-persistence.ts', 'src/infrastructure/database/subscriptions.ts', 'src/integrations/stripe/checkout-client.ts', 'src/integrations/stripe/client.ts', 'src/infrastructure/database/database-client.ts', 'src/integrations/whatsapp/kapso-errors.ts', 'src/integrations/whatsapp/kapso-dispatch.ts', 'src/http/webhooks/billing-webhook-ports.ts', 'src/http/webhooks/stripe-handler.ts', 'src/http/webhooks/stripe.ts', 'src/jobs/memory-extraction-queue.ts', 'src/jobs/memory-extractor.ts', 'src/integrations/stripe/subscription-client.ts', 'src/features/calendar/watch-ports.ts', 'src/http/webhooks/user-webhook-queue.ts', 'src/http/webhooks/google-calendar-handler.ts', 'src/jobs/calendar-watch-renewal-core.ts', 'src/http/webhooks/google-calendar.ts', 'src/jobs/calendar-watch-renewal.ts', 'src/infrastructure/database/reminder-persistence-client.ts', 'src/infrastructure/database/reminder-persistence.ts', 'src/infrastructure/database/reminder-delivery-persistence.ts', 'src/infrastructure/database/reminder-overview.ts', 'src/infrastructure/database/index.ts'].includes(path))
      provenance.find(file => file.path === path)!.role = 'language_guard_read_only';
    if (['src/shared/agenda-scopes.ts','src/shared/read-scope-normalization.ts'].includes(path))
      provenance.find(file => file.path === path)!.role = 'scope_helpers_read_only';
  }

  function validate(content: string, fixture: EvaluationFixture): EvaluationValidation {
    if (fixture.phase === 'continuation') return phases.validateContinuationDecision(contracts.parseIntentArguments(content)) as unknown as EvaluationValidation;
    if (fixture.phase === 'approval') return phases.validateApprovalDecision(contracts.parseIntentArguments(content)) as unknown as EvaluationValidation;
    return validateForegroundContent(content, { isAdmin: false,
      hasHistoricalEvidence: fixture.hasHistoricalEvidence === true, currentUserText: fixture.text }) as unknown as EvaluationValidation;
  }
  function prepare(fixture: EvaluationFixture) {
    const started = performance.now();
    const context = structuredClone(fixture.context);
    let system = prompt.buildAgentCorePrompt({ ...context, userMessage: fixture.text });
    if (fixture.activeRun) system += `\n\n${runPrompt(fixture.activeRun)}`;
    const messages = [{ role: 'system', content: system },
      ...history.historyContextForModel(history.compactHistoryForModel(fixture.history || [])),
      ...history.currentTurnMessages(fixture.modelContext || fixture.text, fixture.text)];
    const phaseSchema = fixture.phase === 'approval' ? phases.APPROVAL_DECISION_SCHEMA
      : fixture.phase === 'continuation' ? phases.CONTINUATION_DECISION_SCHEMA : comparisonSchema.getStructuredTurnSchema();
    const name = fixture.phase === 'approval' ? 'hermes_approval_decision'
      : fixture.phase === 'continuation' ? 'hermes_continuation_decision' : 'hermes_turn_intent';
    const payload = buildRequestPayload(messages, 'openai/gpt-oss-120b', {
      temperature: 0, max_tokens: fixture.phase === 'initial' ? 8192 : 4096,
      responseFormat: { type: 'json_schema', json_schema: { name, strict: true, schema: phaseSchema } },
      tools: null, toolChoice: 'none', parallelToolCalls: undefined,
      reasoning: { effort: 'medium', exclude: true }, providers: ['groq'], allowProviderFallbacks: false,
    });
    const serializedBody = JSON.stringify(payload);
    const fixtureWire = completeFixtureWire(fixture.wire, phaseSchema as SchemaNode);
    if (!matchesSchema(fixtureWire, phaseSchema as Parameters<typeof matchesSchema>[1])) throw new Error('Synthetic fixture violates actual provider schema subset');
    return { payload, serializedBody, fixture, sourceCommit, preparationMs: performance.now() - started,
      fixtureWire,
      validate: (content: string) => validate(content, fixture),
      validateWire: (content: string): EvaluationValidation => {
        const parsed = contracts.parseIntentArguments(content);
        return matchesSchema(parsed, phaseSchema as Parameters<typeof matchesSchema>[1]) ? validate(content, fixture)
          : { valid: false, errorCode: 'INVALID_PROVIDER_SHAPE' };
      }, validation: validate(JSON.stringify(fixtureWire), fixture) };
  }
  return { sourceCommit, baselineSchemaCommit, hashes, provenance, prepare, validate, buildRequestPayload,
    comparisonMode: 'mixed_source_schema_only', schemaVersion: hash(contracts.TURN_INTENT_SCHEMA),
    policyVersion: hash(Object.fromEntries(policyFiles.map(path => [path, hashes[path]]))) };
}
