import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { TURN_INTENT_SCHEMA, getCanonicalOperations, parseCanonicalOperation } from '../../../src/agent/contracts/intent-contracts.js';
import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';
import { buildAgentCorePrompt } from '../../../src/agent/core/agent-core.js';
import { TURN_LANGUAGE_POLICY } from '../../../src/agent/contracts/response-policy.js';

// Evaluate only the pure projection, never a historical module with imports or
// executable evaluation drivers. The immutable commit is the comparison input.
const baselineSource = execFileSync('git', ['show', '1290e81:src/agent/contracts/foreground-turn-schema.js'], { encoding: 'utf8' });
const baselineProjection = new Function('TURN_INTENT_SCHEMA', 'getCanonicalOperations', 'parseCanonicalOperation',
  baselineSource.replace(/^import \{[\s\S]*?\} from .*?;\n/, '').replaceAll('export function ', 'function ')
    + '\nreturn getStructuredTurnSchema;')(TURN_INTENT_SCHEMA, getCanonicalOperations, parseCanonicalOperation);
const variants = [
  { isAdmin: false, attachmentOnly: false }, { isAdmin: true, attachmentOnly: false },
  { isAdmin: false, attachmentOnly: true }, { isAdmin: true, attachmentOnly: true },
];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function withoutDescriptions(value) {
  const node = structuredClone(value);
  // Only schema metadata: the actual action field named "description" must
  // remain in properties and required, and retain its type/nullability.
  delete node.description;
  if (node.properties) node.properties = Object.fromEntries(Object.entries(node.properties)
    .map(([field, child]) => [field, withoutDescriptions(child)]));
  if (node.items) node.items = withoutDescriptions(node.items);
  return node;
}

function changedDescriptions(before, after, path = '') {
  const changed = before.description === after.description ? [] : [path];
  if (before.properties) for (const field of Object.keys(before.properties)) {
    changed.push(...changedDescriptions(before.properties[field], after.properties[field], `${path}/properties/${field}`));
  }
  if (before.items) changed.push(...changedDescriptions(before.items, after.items, `${path}/items`));
  return changed;
}

// Use the actual production payload statements without HTTP, keys or an app.
// Source extraction fails closed if this seam changes; runtime-model-contract
// also checks the body captured at the mocked production fetch boundary.
const clientSource = readFileSync(new URL('../../../src/agent/providers/client.js', import.meta.url), 'utf8');
const payloadStatements = clientSource.slice(clientSource.indexOf('    const payload = { model, messages, temperature, max_tokens };'),
  clientSource.indexOf('    measurements = measureSerializedRequest(serializedBody);'));
if (!payloadStatements.includes('const serializedBody = JSON.stringify(payload);')) throw new Error('Production payload seam missing');
const serializeRequest = new Function('messages', 'responseFormat', `
  const model = 'openai/gpt-oss-120b', temperature = 0, max_tokens = 8192;
  const strictForeground = true, tools = null, toolChoice = 'none', parallelToolCalls = undefined;
  const reasoning = { effort: 'medium', exclude: true };
  const requestedProviders = ['groq'], allowProviderFallbacks = false;
  ${payloadStatements}
  return serializedBody;
`);
const prompt = buildAgentCorePrompt({ nowStr: '2026-10-01 11:30', nowHumanStr: 'Thursday, October 1, 2026',
  timezone: 'America/Bogota', language: 'en', memoryHints: '', overview: null });
const messages = [{ role: 'system', content: prompt }, { role: 'user', content: 'List my tasks.' }];
const request = schema => serializeRequest(messages, { type: 'json_schema', json_schema: { name: 'hermes_turn_intent', strict: true, schema } });
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

// Phrase-level obligation coverage is deliberately independent of structural
// fingerprints. These phrases name concrete rules, not opaque policy IDs.
const actionRules = {
  contextRef: ['Working Memory', 'position, time, recurrence or title', 'sole operative identity', 'omit target', 'redundant labels ignored'],
  target: ['never internal IDs', 'without contextRef', 'reminder.acknowledge', 'one authoritative active follow-up', 'deleting a project deletes all its tasks in cascade', 'never scope="all" for one project'],
  entityName: ['own name', 'implicit/explicit container', 'system domain', 'owning named container', 'duplicate titles'],
  category: ['person/company/project/place/asset/other', 'omitted=other', 'pet is not a physical write', 'task container', 'memory.save'],
  projectless: ['no named grouping or shared purpose', 'implicit/explicit purpose', 'entityName', 'list/project'],
  evidenceRefs: ['supplied operational refs', 'Content with refs is discarded', 'owned historical proof, not fresh state', 'knowledgeRefs', 'No additional actions'],
  returnFields: ['task.list only', 'null=absent, missing=unknown', 'query/entityName/status/date filters', 'takes precedence over answerFromResults', 'No ordinal identity or calculations'],
  query: ['literal case-insensitive content', '1–200 trimmed characters, no * or NUL', 'never dates/times', 'calendar_date_time', 'allDay=true', 'query dates do not restrict the window'],
  recurrence: ['daily|weekdays|weekly|monthly|yearly|hourly', 'hourly:N', 'interval:Xm', 'interval:Xh', 'every N hours', 'exactly every 1 hour'],
  advanceMinutes: ['Calendar notification offset', 'reminders prefer deliveryPolicy', 'desired state, not a separate action'],
  deliveryPolicy: ['explicitly requested/changed', 'preserve known state', 'Never invent advance notice'],
};
const turnRules = {
  answerFromResults: ['interpretation/calculation/comparison', 'live reads', 'emit those reads', 'returnFields absent', 'listings/simple returnFields/mutations', 'projection takes precedence'],
  knowledgeRefs: ['Turn RESPONSE metadata, not tool actions', 'supplied pk_ refs', 'mixed tasks/personal recall', 'recorded personal quotations, never fresh operational state', 'Only reads/conversation; no mutations or guessed refs', 'content without refs'],
};
function assertSemanticCoverage(schema) {
  for (const [field, clauses] of Object.entries(actionRules)) {
    for (const clause of clauses) expect(schema.properties.actions.items.properties[field].description, `${field}: ${clause}`).toContain(clause);
  }
  for (const [field, clauses] of Object.entries(turnRules)) {
    for (const clause of clauses) expect(schema.properties[field].description, `${field}: ${clause}`).toContain(clause);
  }
}

function assertProfileAndPreferenceCoverage(schema, systemPrompt) {
  expect(schema.properties.profileUpdate.properties.sourceQuote.description).toContain('Exact current-user authored excerpt');
  expect(schema.properties.profileUpdate.description).toContain('quoted text');
  expect(schema.properties.profileUpdate.properties.language.description).toContain('Never persist quoted or one-turn switches');
  expect(systemPrompt).toContain('Aplica las preferencias y reglas del usuario (<user_preferences>) al configurar recordatorios, tareas y respuestas');
}

describe('provider-only description compaction', () => {
  it.each(variants)('reduces the actual serialized request, not merely an instrumentation counter: %j', options => {
    const before = baselineProjection(options);
    const after = getStructuredTurnSchema(options);
    const oldBody = request(before), newBody = request(after);
    expect(JSON.parse(newBody).messages).toEqual(JSON.parse(oldBody).messages);
    expect(bytes(newBody)).toBeLessThan(bytes(oldBody));
    if (!options.attachmentOnly) expect(bytes(oldBody) - bytes(newBody)).toBeGreaterThanOrEqual(1200);
    process.stdout.write(`PROVIDER_COMPACTION_BYTES ${JSON.stringify({ ...options, before: bytes(oldBody), after: bytes(newBody), messages: bytes(messages), schemaBefore: bytes(before), schemaAfter: bytes(after) })}\n`);
  });

  it('keeps the full canonical schema and all four structural fingerprints anchored to the baseline', () => {
    expect(digest(TURN_INTENT_SCHEMA)).toBe('40c6cd8f9ba705137012e006127a34ef8edd0da8f929a57874cd705056a9b905');
    // Computed from 1290e81 once, after preserving the action field whose name
    // is itself description. Only JSON Schema description metadata is removed.
    const fingerprints = ['c3d83bcb7cb544d3cec46e6054abb0393afd6864fec141c7576f15fe141862c5',
      '9a329279ac8234ebea74b7414ae1569b74dd7d145bf76500a091d5f45a3674d7',
      'db4891d517465f5cd7736f988eab819723a935272d240c9497e2f36087701eee',
      'db4891d517465f5cd7736f988eab819723a935272d240c9497e2f36087701eee'];
    const snapshot = structuredClone(TURN_INTENT_SCHEMA);
    variants.forEach((options, index) => {
      expect(digest(withoutDescriptions(baselineProjection(options)))).toBe(fingerprints[index]);
      expect(digest(withoutDescriptions(getStructuredTurnSchema(options)))).toBe(fingerprints[index]);
      expect(withoutDescriptions(getStructuredTurnSchema(options))).toEqual(withoutDescriptions(baselineProjection(options)));
      expect(getStructuredTurnSchema(options).properties.learningCandidates).toEqual(baselineProjection(options).properties.learningCandidates);
      expect(getStructuredTurnSchema(options).properties.profileUpdate).toEqual(baselineProjection(options).properties.profileUpdate);
    });
    expect(TURN_INTENT_SCHEMA).toEqual(snapshot);
  });

  it.each(variants)('changes only the approved field-local descriptions: %j', options => {
    const allowed = [
      ...Object.keys(turnRules).map(field => `/properties/${field}`), '/properties/responseLanguage',
      ...(options.attachmentOnly ? [] : [
        ...Object.keys(actionRules).map(field => `/properties/actions/items/properties/${field}`),
        ...['dayOffset', 'offsetMinutes'].map(field => `/properties/actions/items/properties/endSchedule/properties/${field}`),
      ]),
    ];
    expect(changedDescriptions(baselineProjection(options), getStructuredTurnSchema(options)).sort()).toEqual(allowed.sort());
  });

  it('retains each compacted field obligation explicitly', () => {
    assertSemanticCoverage(getStructuredTurnSchema());
  });

  it.each([
    ['entityName', 'owning named container'], ['evidenceRefs', 'owned historical proof, not fresh state'],
    ['query', 'calendar_date_time'], ['deliveryPolicy', 'explicitly requested/changed'],
  ])('detects removal of protected semantics: %s / %s', (field, clause) => {
    const changed = getStructuredTurnSchema();
    changed.properties.actions.items.properties[field].description = changed.properties.actions.items.properties[field].description.replace(clause, '');
    expect(() => assertSemanticCoverage(changed)).toThrow();
  });

  it('detaches endSchedule and keeps the full primary temporal instructions', () => {
    const before = baselineProjection().properties.actions.items.properties;
    const fields = getStructuredTurnSchema().properties.actions.items.properties;
    expect(fields.schedule).toEqual(before.schedule);
    expect(fields.endSchedule).not.toBe(fields.schedule);
    for (const field of ['dayOffset', 'offsetMinutes']) {
      expect(fields.endSchedule.properties[field].description).toBe(`Same semantics as schedule.${field}.`);
      expect(fields.endSchedule.properties[field]).not.toBe(fields.schedule.properties[field]);
    }
    fields.endSchedule.properties.dayOffset.description = 'Changed test copy';
    expect(getStructuredTurnSchema().properties.actions.items.properties.schedule).toEqual(before.schedule);
    expect(fields.schedule).toEqual(before.schedule);
  });

  it('keeps profile quotes, delivery offsets and user-preference deadline guidance visible', () => {
    const schema = getStructuredTurnSchema();
    assertProfileAndPreferenceCoverage(schema, prompt);
    const policy = schema.properties.actions.items.properties.deliveryPolicy;
    expect(policy.properties.advanceNotice.description).toContain('before the primary reminder');
    expect(policy.properties.advanceMinutes.description).toContain('Required only when advanceNotice=offset');
    const changed = structuredClone(schema);
    changed.properties.profileUpdate.properties.sourceQuote.description = 'Any quote';
    expect(() => assertProfileAndPreferenceCoverage(changed, prompt)).toThrow();
    const missingPreference = prompt.replace('Aplica las preferencias y reglas del usuario (<user_preferences>) al configurar recordatorios, tareas y respuestas', '');
    expect(() => assertProfileAndPreferenceCoverage(schema, missingPreference)).toThrow();
  });

  it('documents every compacted field and the full model-visible language-policy proof', () => {
    const guide = readFileSync(new URL('../../../docs/agent/groq-contract-evaluation.md', import.meta.url), 'utf8');
    for (const field of [...Object.keys(actionRules), ...Object.keys(turnRules), 'responseLanguage', 'endSchedule.dayOffset', 'endSchedule.offsetMinutes']) {
      expect(guide).toContain(`\`${field}\``);
    }
    expect(guide).toContain('TURN_LANGUAGE_POLICY');
    expect(guide).toContain('buildAgentCorePrompt');
    expect(guide).toContain('learningCandidates');
  });

  it('rejects structural mutations even when descriptions alone are ignored', () => {
    const baseline = withoutDescriptions(baselineProjection());
    for (const mutate of [
      schema => delete schema.properties.actions.items.properties.schedule.properties.hour.maximum,
      schema => schema.properties.actions.items.required.pop(),
      schema => schema.properties.actions.items.properties.operation.enum.pop(),
      schema => schema.properties.actions.items.properties.target.type.pop(),
      schema => delete schema.properties.actions.items.properties.description,
    ]) {
      const changed = getStructuredTurnSchema();
      mutate(changed);
      expect(withoutDescriptions(changed)).not.toEqual(baseline);
    }
  });

  it('keeps complete language precedence in the real model-visible system message', () => {
    expect(JSON.parse(request(getStructuredTurnSchema())).messages[0].content).toContain(TURN_LANGUAGE_POLICY);
    expect(prompt).toContain('neutral Colombian Spanish with tuteo, no voseo or regional slang');
    expect(getStructuredTurnSchema().properties.responseLanguage.description).toContain('entire response');
  });
});
