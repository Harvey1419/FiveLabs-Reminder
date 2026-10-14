import { describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider, type StructuredAIProvider, type StructuredCompletionRequest } from '@templelabs/ai';
import { jsonObjectSchema, type JsonObject, type SuspendedRunSnapshot } from '@templelabs/contracts';
import { completeApprovalDecision, completeContinuationDecision } from '../../../src/adapters/agent-core/active-run-ai-decision.js';
import { APPROVAL_DECISION_SCHEMA, CONTINUATION_DECISION_SCHEMA } from '../../../src/agent/contracts/agent-run-contracts.js';

const instant = Date.parse('2026-10-11T19:00:00Z');
function run(status: SuspendedRunSnapshot['status'] = 'waiting_for_approval'): SuspendedRunSnapshot {
  return { runId: 'suspended', userId: 'owner', threadId: 'thread', status,
    expiresAtIso: new Date(instant + 60000).toISOString(), actions: ['first', 'second', 'done'].map(callId => ({
      callId, domain: 'task', action: 'delete', targetId: callId, targetName: callId,
      payload: { target: callId }, status: callId === 'done' ? 'executed' : 'prepared',
    })) };
}
function context() {
  return { turn: { userId: 'owner', runId: 'inbound', requestId: 'request', language: 'es' as const,
    timezone: 'America/Bogota', referenceTimeIso: new Date(instant).toISOString(), capabilities: new Set<string>(), signal: new AbortController().signal },
  threadId: 'thread', currentUserText: 'Aprueba la segunda ahora, English always', now: () => instant };
}
type MutableRequest = { -readonly [K in keyof Omit<StructuredCompletionRequest, 'output' | 'validate'>]: StructuredCompletionRequest[K] };
function request(): MutableRequest {
  return { messages: [{ role: 'user', content: 'La segunda' }], maxOutputTokens: 500,
    deadlineMs: instant + 30000, signal: new AbortController().signal };
}
const usage = { inputTokens: 10, outputTokens: 5 };
function approval(extra: JsonObject = {}): JsonObject {
  return { responseLanguage: 'es', profileUpdate: null, relation: 'approval', decision: 'approve_subset',
    selectedCallIds: ['second'], reply: null, ...extra };
}
function continuation(extra: JsonObject = {}): JsonObject {
  return { responseLanguage: 'es', profileUpdate: null, relation: 'resume',
    actionInputs: [{ callId: 'second', fields: { schedule: { kind: 'relative_offset', offsetMinutes: 0 } } }], reply: null, ...extra };
}
function provider(data: JsonObject, options: { skipValidation?: boolean; during?: (req: StructuredCompletionRequest) => void; refused?: boolean } = {}) {
  const completeStructured = vi.fn(async (req: StructuredCompletionRequest) => {
    options.during?.(req);
    return options.refused ? { status: 'refused' as const, data: null, usage }
      : { status: 'success' as const, data: options.skipValidation ? data : req.validate(data), usage };
  });
  const instance: StructuredAIProvider = { capabilities: { toolCalling: false, structuredOutput: true },
    complete: async () => { throw new Error('native path forbidden'); }, completeStructured };
  return { instance, completeStructured };
}

describe('portable active-run decisions', () => {
  it('uses the actual approval wire contract and binds selected pending IDs without granting execution', async () => {
    const p = provider(approval());
    const result = await completeApprovalDecision(p.instance, request(), run(), context());
    expect(result).toMatchObject({ status: 'success', suggestedCallIds: ['second'], usage,
      binding: { runId: 'suspended', inboundRunId: 'inbound', requestId: 'request', freshness: 'snapshot', grantsExecution: false } });
    expect(result.binding.snapshotFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const req = p.completeStructured.mock.calls[0]![0];
    expect(req.output.schema).toEqual(APPROVAL_DECISION_SCHEMA);
    expect(req.messages[0]?.content).toContain('"callId":"second"');
  });
  it('approve_all expands only the prepared actions', async () => {
    const result = await completeApprovalDecision(provider(approval({ decision: 'approve_all', selectedCallIds: null })).instance, request(), run(), context());
    expect(result.suggestedCallIds).toEqual(['first', 'second']);
  });
  it.each(['cancel', 'unrelated', 'supersede', 'reject'])('%s yields no action suggestions', async value => {
    const data = value === 'reject' ? approval({ decision: value }) : approval({ relation: value });
    const result = await completeApprovalDecision(provider(data).instance, request(), run(), context());
    expect(result.suggestedCallIds).toEqual([]);
  });
  it.each([['foreign'], ['done'], ['second', 'second'], [2]])('rejects unknown/executed/duplicate/non-string selections %j', async (...ids) => {
    await expect(completeApprovalDecision(provider(approval({ selectedCallIds: ids })).instance, request(), run(), context())).rejects.toThrow();
  });
  it('checks the final host boundary when another vendor ignores the validation callback', async () => {
    await expect(completeApprovalDecision(provider(approval({ selectedCallIds: ['foreign'] }), { skipValidation: true }).instance,
      request(), run(), context())).rejects.toThrow('UNMATCHED_PREPARED_ACTION');
  });
  it('preserves a per-action immediate schedule and uses the actual continuation contract', async () => {
    const p = provider(continuation());
    const result = await completeContinuationDecision(p.instance, request(), run('waiting_for_input'), context());
    expect(result).toMatchObject({ suggestedCallIds: ['second'], decision: { suppliedFields: {},
      actionInputs: [{ callId: 'second', fields: { schedule: { kind: 'relative_offset', offsetMinutes: 0 } } }] } });
    expect(p.completeStructured.mock.calls[0]![0].output.schema).toEqual(CONTINUATION_DECISION_SCHEMA);
  });
  it.each([
    { actionInputs: [{ callId: 'foreign', fields: { content: 'A' } }] },
    { actionInputs: [{ callId: 'done', fields: { content: 'A' } }] },
    { actionInputs: [{ callId: 'first', fields: { content: 'A' } }, { callId: 'first', fields: { content: 'B' } }] },
    { actionInputs: [{ callId: 'second', fields: { content: null } }] },
    { actionInputs: [{ callId: 'second', fields: { domain: 'admin' } }] },
    { actionInputs: [], suppliedFields: { content: 'shared' } },
  ])('rejects invalid or ambiguous continuation delta %j', async extra => {
    await expect(completeContinuationDecision(provider(continuation(extra)).instance, request(), run('waiting_for_input'), context())).rejects.toThrow();
  });
  it.each(['cancel', 'unrelated', 'supersede'])('continuation %s discards deltas', async relation => {
    const result = await completeContinuationDecision(provider(continuation({ relation })).instance, request(), run('waiting_for_input'), context());
    expect(result.suggestedCallIds).toEqual([]);
  });
  it('retains sourced bilingual preference but rejects a foreign quote', async () => {
    const result = await completeApprovalDecision(provider(approval({ profileUpdate: { sourceQuote: 'English always', language: 'en' } })).instance, request(), run(), context());
    expect(result.decision?.profileUpdate?.language).toBe('en');
    await expect(completeApprovalDecision(provider(approval({ profileUpdate: { sourceQuote: 'foreign', language: 'en' } })).instance,
      request(), run(), context())).rejects.toThrow('INVALID_PROFILE_SOURCE');
  });
  it.each(['owner', 'thread', 'state', 'expired', 'duplicate', 'empty'])('blocks %s invalid run before a provider call', async issue => {
    const state = run();
    if (issue === 'owner') state.userId = 'foreign';
    if (issue === 'thread') state.threadId = 'foreign';
    if (issue === 'state') state.status = 'waiting_for_input';
    if (issue === 'expired') state.expiresAtIso = new Date(instant).toISOString();
    if (issue === 'duplicate') state.actions[1]!.callId = 'first';
    if (issue === 'empty') state.actions.forEach(a => { a.status = 'executed'; });
    const p = provider(approval());
    await expect(completeApprovalDecision(p.instance, request(), state, context())).rejects.toThrow();
    expect(p.completeStructured).not.toHaveBeenCalled();
  });
  it.each(['expiry', 'deadline', 'abort'])('blocks late %s results even if the vendor ignores its deadline', async issue => {
    let clock = instant;
    const ctx = context(), req = request(), controller = new AbortController();
    ctx.now = () => clock;
    req.signal = controller.signal;
    const p = provider(approval(), { during: () => {
      clock += issue === 'expiry' ? 60000 : issue === 'deadline' ? 30000 : 0;
      if (issue === 'abort') controller.abort();
    } });
    await expect(completeApprovalDecision(p.instance, req, run(), ctx)).rejects.toThrow();
  });
  it('captures immutable identity, payload and deadline while model work is in flight', async () => {
    const state = run(), ctx = context(), req = request();
    const baseline = await completeApprovalDecision(provider(approval()).instance, req, state, ctx);
    const p = provider(approval(), { during: () => {
      state.actions[1]!.payload.target = 'changed'; ctx.turn.userId = 'foreign'; req.deadlineMs = instant;
    } });
    const result = await completeApprovalDecision(p.instance, req, state, ctx);
    expect(result.binding).toEqual(baseline.binding);
    const changed = await completeApprovalDecision(provider(approval()).instance, request(), state, context());
    expect(changed.binding.snapshotFingerprint).not.toEqual(baseline.binding.snapshotFingerprint);
  });
  it('returns refusal without any execution suggestions', async () => {
    const result = await completeApprovalDecision(provider({}, { refused: true }).instance, request(), run(), context());
    expect(result).toMatchObject({ status: 'refused', decision: null, suggestedCallIds: [], binding: { grantsExecution: false } });
  });
  it.each([{ responseLanguage: 'fr' }, { profileUpdate: { sourceQuote: 'English always', timezone: 'Invalid/Zone' } }])('keeps language/profile validation %j', async extra => {
    await expect(completeApprovalDecision(provider(approval(extra)).instance, request(), run(), context())).rejects.toThrow('INVALID_ACTIVE_RUN_DECISION');
  });
  it('clamps the model deadline to run expiry and rejects malformed returned usage', async () => {
    const req = request(); req.deadlineMs = instant + 120000;
    const p = provider(approval());
    await completeApprovalDecision(p.instance, req, run(), context());
    expect(p.completeStructured.mock.calls[0]![0].deadlineMs).toBe(instant + 60000);
    const bad = { ...p.instance, completeStructured: async () => ({ status: 'success' as const, data: approval(), usage: { inputTokens: -1, outputTokens: 0 } }) };
    await expect(completeApprovalDecision(bad, request(), run(), context())).rejects.toThrow();
  });
  it('preserves distinct deltas for each pending action without merging the draft', async () => {
    const state = run('waiting_for_input');
    const before = structuredClone(state);
    const result = await completeContinuationDecision(provider(continuation({ actionInputs: [
      { callId: 'first', fields: { content: 'Primera' } }, { callId: 'second', fields: { content: 'Segunda' } },
    ] })).instance, request(), state, context());
    expect(result.suggestedCallIds).toEqual(['first', 'second']);
    expect(state).toEqual(before);
  });
  it('uses metered fallback for a locally invalid selection with aggregate accounting', async () => {
    const bodies: JsonObject[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(jsonObjectSchema.parse(JSON.parse(String(init?.body))));
      const content = bodies.length === 1 ? approval({ selectedCallIds: ['foreign'] }) : approval();
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
    const p = new OpenRouterProvider({ apiKey: 'fixture-only', now: () => instant, fetch,
      routes: ['first', 'second'].map(id => ({ id, model: `fixture/${id}`, providers: [id], timeoutMs: 1000, structuredOutput: true })) });
    const result = await completeApprovalDecision(p, request(), run(), context());
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toHaveProperty('tools');
    expect(bodies[0]).toMatchObject({ response_format: { type: 'json_schema', json_schema: { name: 'hermes_approval_decision', strict: true } } });
  });
});
