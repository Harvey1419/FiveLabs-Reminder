import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const PREFIX = 'src/agent/contracts/';
const pureFiles = new Set([
  'intent-contracts.js', 'turn-context.js', 'response-policy.js', 'tool-names.js',
  'schema-value.js', 'foreground-turn-schema.js', 'agent-run-contracts.js', 'foreground-turn-validation.js',
].map(name => PREFIX + name).concat([
  'src/agent/core/agent-core.js', 'src/agent/providers/request-payload.js',
  'src/shared/agenda-scopes.js', 'src/shared/entity-categories.js', 'src/shared/entity-resolution.js',
]));

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** Only local hexadecimal commit identities, never revisions/options/path expressions. */
export function validateBaselineRef(ref) {
  if (typeof ref !== 'string' || !/^[a-f0-9]{7,40}$/.test(ref)) throw new Error('Baseline must be a local hexadecimal commit identity');
  return ref;
}

/** Bounded adapter for this repository's static named imports/exports, not a JS parser.
 * Trusted repository commits ONLY. VM contexts are NOT security sandboxes.
 * Unknown imports and syntax are denied; dynamic imports are not supported.
 */
export function evaluateModule(source, resolveImport, extra = {}) {
  const bindings = {};
  const transformed = source.replace(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm, (_line, names, specifier) => {
    const imported = resolveImport(specifier);
    for (const entry of names.split(',').map(name => name.trim()).filter(Boolean)) {
      const [name, alias = name] = entry.split(/\s+as\s+/);
      if (!Object.hasOwn(imported, name)) throw new Error('Missing allowlisted import binding');
      bindings[alias] = imported[name];
    }
    return '';
  });
  // Reject unknown/default/namespace imports through the same deny-by-default resolver.
  const unknown = transformed.match(/^import\s+[\s\S]*?from\s*['"]([^'"]+)['"]/m);
  if (unknown) { resolveImport(unknown[1]); throw new Error('Unsupported import form'); }
  if (/\bimport\s*\(/.test(transformed) || /^import\s/m.test(transformed)) throw new Error('Unsupported import form');
  const names = [...transformed.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/gm)].map(match => match[1]);
  const body = transformed.replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\s)/gm, '');
  if (/^export\s/m.test(body)) throw new Error('Unsupported export form');
  return runInNewContext(`(() => { ${body}\nreturn {${names.join(',')}}; })()`,
    { ...bindings, structuredClone, ...extra }, { timeout: 2000 });
}

function extractFunction(source, name) {
  const match = source.match(new RegExp(`(?:export )?function ${name}\\([^]*?\\n\\}`, 'm'));
  if (!match) throw new Error(`Trusted source boundary missing: ${name}`);
  return match[0].replace(/^export /, '');
}

/** Fill only required strict-wire fields from the actual provider schema. */
export function completeFixtureWire(value, schema) {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(item => completeFixtureWire(item, schema.items));
  if (value && typeof value === 'object' && schema.properties) {
    const completed = {};
    for (const key of schema.required || []) completed[key] = value[key] === undefined ? null
      : completeFixtureWire(value[key], schema.properties[key]);
    for (const [key, item] of Object.entries(value)) if (!Object.hasOwn(completed, key) && item !== undefined) {
      completed[key] = schema.properties[key] ? completeFixtureWire(item, schema.properties[key]) : item;
    }
    return completed;
  }
  return value;
}

function localCommit(ref) {
  const commit = execFileSync('git', ['rev-parse', '--verify', ref ? `${validateBaselineRef(ref)}^{commit}` : 'HEAD'],
    { cwd: root, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid local commit identity');
  return commit;
}

/** Test-only legacy parity adapter: exact historical wire statements, no client execution. */
export function loadLegacyRequestBuilder(ref) {
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

function structuralSchema(value) {
  const node = structuredClone(value);
  delete node.description;
  if (node.properties) node.properties = Object.fromEntries(Object.entries(node.properties).map(([key, child]) => [key, structuralSchema(child)]));
  if (node.items) node.items = structuralSchema(node.items);
  return node;
}

export function loadVariant(ref, { readSource } = {}) {
  const sourceCommit = localCommit(null);
  const baselineSchemaCommit = ref ? localCommit(ref) : null;
  if (ref && !baselineSchemaCommit.startsWith('1290e81')) throw new Error('Unsupported baseline projection layout');
  const hashes = {}, provenance = [], cache = new Map();
  function read(path) {
    const source = readSource ? readSource(path) : readFileSync(resolve(root, path), 'utf8');
    hashes[path] = hash(source);
    if (!provenance.some(file => file.path === path && file.origin === 'current_working_tree'))
      provenance.push({ path, origin: 'current_working_tree', ref: sourceCommit, hash: hashes[path], role: 'current_runtime' });
    return source;
  }
  function module(path) {
    if (cache.has(path)) return cache.get(path);
    // Explicit identical fixture adapters; never evaluate DB/Google modules.
    let adapter;
    if (path === 'src/integrations/google/auth.js') adapter = { hasUsableGoogleCredentials: integration => integration?.syntheticConnected === true };
    if (path === 'src/infrastructure/database/entities.js') adapter = {
      normalizeEntityName: value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(),
      entityMatchScore: (a, b) => a === b ? 1 : 0,
    };
    if (adapter) {
      provenance.push({ path, origin: 'synthetic_adapter', ref: 'fake-context-adapter-v1',
        hash: hash(Object.fromEntries(Object.entries(adapter).map(([name, fn]) => [name, String(fn)]))), role: 'fake_context_adapter' });
      cache.set(path, adapter);
      return adapter;
    }
    if (path === 'src/agent/orchestration/personal-knowledge.js') {
      const source = read(path).match(/^export const PERSONAL_READ_OPERATIONS = [^\n]+/m)?.[0];
      if (!source) throw new Error('Trusted read-operation boundary missing');
      const result = evaluateModule(source, () => { throw new Error('Denied import'); });
      cache.set(path, result);
      return result;
    }
    if (!pureFiles.has(path)) throw new Error('Denied import');
    const result = evaluateModule(read(path), specifier => {
      if (!specifier.startsWith('.')) throw new Error('Denied import');
      return module(posix.normalize(posix.join(posix.dirname(path), specifier)));
    });
    cache.set(path, result);
    return result;
  }
  const contracts = module(PREFIX + 'intent-contracts.js');
  const schema = module(PREFIX + 'foreground-turn-schema.js');
  const phases = module(PREFIX + 'agent-run-contracts.js');
  const { matchesSchema } = module(PREFIX + 'schema-value.js');
  const prompt = module('src/agent/core/agent-core.js');
  const router = read('src/agent/orchestration/router-core.js');
  read('src/agent/providers/client.js');
  const { buildRequestPayload } = module('src/agent/providers/request-payload.js');
  const { validateForegroundContent } = module(PREFIX + 'foreground-turn-validation.js');
  let comparisonSchema = schema;
  if (ref) {
    const path = PREFIX + 'foreground-turn-schema.js';
    const source = execFileSync('git', ['show', `${baselineSchemaCommit}:${path}`], { cwd: root, encoding: 'utf8' });
    hashes[`baseline:${path}`] = hash(source);
    provenance.push({ path, origin: 'baseline_commit', ref: baselineSchemaCommit, hash: hash(source), role: 'comparison_schema' });
    comparisonSchema = evaluateModule(source, specifier => {
      if (specifier !== './intent-contracts.js') throw new Error('Denied baseline projection import');
      return contracts;
    });
  }
  if (hash(contracts.TURN_INTENT_SCHEMA) !== '40c6cd8f9ba705137012e006127a34ef8edd0da8f929a57874cd705056a9b905')
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
  const historyNames = ['compactHistoryForModel', 'historyContextForModel', 'currentTurnMessages'];
  const historyConstants = router.match(/^const (?:MAX_HISTORY_[^\n]+|HISTORY_STATE_BOUNDARY[^\n]+|HISTORICAL_ASSISTANT_PREFIX[^\n]+)/gm);
  if (historyConstants?.length !== 5) throw new Error('Trusted history boundary missing');
  const history = runInNewContext(`(() => { ${historyConstants.join('\n')}
    ${historyNames.map(name => extractFunction(router, name)).join('\n')}
    return {${historyNames.join(',')}}; })()`);
  const runPrompt = runInNewContext(`(${extractFunction(read('src/agent/core/agent-run.js'), 'formatActiveRunPrompt')})`,
    { CONTINUATION_DECISION_SCHEMA: phases.CONTINUATION_DECISION_SCHEMA });
  // Provenance only: NEVER evaluate effect-owning modules or relocate their guards.
  const policyFiles = ['src/agent/contracts/response-policy.js', 'src/agent/core/agent-core.js',
    'src/agent/orchestration/router-core.js', 'src/agent/orchestration/domain-call.js',
    'src/agent/orchestration/intent-executor.js', 'src/shared/language-detection.js'];
  for (const path of policyFiles) {
    if (!hashes[path]) read(path);
    if (path.includes('/orchestration/') || path.endsWith('language-detection.js'))
      provenance.find(file => file.path === path).role = 'language_guard_read_only';
  }

  function validate(content, fixture) {
    if (fixture.phase === 'continuation') return phases.validateContinuationDecision(contracts.parseIntentArguments(content));
    if (fixture.phase === 'approval') return phases.validateApprovalDecision(contracts.parseIntentArguments(content));
    return validateForegroundContent(content, { isAdmin: false,
      hasHistoricalEvidence: fixture.hasHistoricalEvidence === true, currentUserText: fixture.text });
  }
  function prepare(fixture) {
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
    const fixtureWire = completeFixtureWire(fixture.wire, phaseSchema);
    if (!matchesSchema(fixtureWire, phaseSchema)) throw new Error('Synthetic fixture violates actual provider schema subset');
    return { payload, serializedBody, fixture, sourceCommit, preparationMs: performance.now() - started,
      fixtureWire,
      validate: content => validate(content, fixture),
      validateWire: content => {
        const parsed = contracts.parseIntentArguments(content);
        return matchesSchema(parsed, phaseSchema) ? validate(content, fixture)
          : { valid: false, errorCode: 'INVALID_PROVIDER_SHAPE' };
      }, validation: validate(JSON.stringify(fixtureWire), fixture) };
  }
  return { sourceCommit, baselineSchemaCommit, hashes, provenance, prepare, validate, buildRequestPayload,
    comparisonMode: 'mixed_source_schema_only', schemaVersion: hash(contracts.TURN_INTENT_SCHEMA),
    policyVersion: hash(Object.fromEntries(policyFiles.map(path => [path, hashes[path]]))) };
}
