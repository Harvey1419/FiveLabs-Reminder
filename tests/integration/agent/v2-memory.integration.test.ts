import { createProactiveMemory, scheduleProactiveMemory } from '../../../src/adapters/agent-core/proactive-memory.js';
vi.mock('../../../src/adapters/agent-core/proactive-memory.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/adapters/agent-core/proactive-memory.js')>(), scheduleProactiveMemory: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAIProvider, OpenRouterProvider, estimateBoundedInput } from '@templelabs/ai';
import { type AIResponse, type JsonObject, productivityCheckpointSchema } from '@templelabs/contracts';
import { nativeMemoryFixture, memoryId } from '../../support/unit/native-memory-fixture.js';
import type { NativeMemoryClient } from '../../../src/features/memory/native-store.js';
const state = vi.hoisted(() => ({ provider: null as MockAIProvider | null, client: null as NativeMemoryClient | null,
  admit: vi.fn(async () => true), verifyForget: vi.fn(async () => true), embed: vi.fn(async () => null) }));
vi.mock('../../../src/adapters/agent-core/configured-ai-provider.js', () => ({ createConfiguredAIProvider: () => state.provider }));
vi.mock('../../../src/adapters/agent-core/memory-admission.js', () => ({ admitExplicitMemory: state.admit, verifyMemoryForget: state.verifyForget, embedExplicitMemory: state.embed }));
vi.mock('../../../src/infrastructure/database/index.js', () => ({ get supabase() { return state.client; }, getUserSubscription: vi.fn(async () => null), hasProAccess: vi.fn(() => false) }));
vi.mock('../../../src/features/memory/service.js', () => ({ retrieveRelevantMemories: vi.fn(async () => []), retrieveStandingPreferences: vi.fn(async () => []) }));
vi.mock('../../../src/features/tasks/productivity-service.js', () => ({ createTaskService: () => ({ execute: async () => { throw new Error('Unexpected task'); } }) }));
vi.mock('../../../src/features/reminders/productivity-service.js', () => ({ createReminderService: () => ({ execute: async () => { throw new Error('Unexpected reminder'); } }) }));
vi.mock('../../../src/features/calendar/productivity-service.js', () => ({ createCalendarService: () => ({ execute: async () => { throw new Error('Unexpected calendar'); } }) }));
import { createNativeMemoryStore } from '../../../src/features/memory/native-store.js';
import { retrieveStandingPreferences, retrieveRelevantMemories } from '../../../src/features/memory/service.js';
import { routeCanaryProductivity } from '../../../src/adapters/agent-core/canary-productivity-router.js';
import { createCanaryRouter } from '../../../src/agent/orchestration/canary-router.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';
import { readPriorInboundTurn, type InboundCheckpointClient } from '../../../src/adapters/agent-core/inbound-checkpoint-reader.js';
function answer(calls: AIResponse['message']['toolCalls'] = []): AIResponse { return { message: { role: 'assistant', content: '', toolCalls: calls.length ? calls
  : [{ id: 'dialogue', name: 'conversation_decide', arguments: { ready: [], reply: 'Listo.' } }] }, stopReason: 'tool_calls', usage: { inputTokens: 30, outputTokens: 10 } }; }
const text = 'Recuerda que vivo en Bogotá';
const content = 'vivo en Bogotá';
const save = { id: 'save', name: 'memory_save', arguments: { content, category: 'fact', evidenceStart: text.indexOf(content), evidenceEnd: text.length } };
function fixture(script: AIResponse[], seed: Record<string, unknown>[] = []) {
  const db = nativeMemoryFixture(seed); state.client = db.client; let persisted: JsonObject = {};
  state.provider = new MockAIProvider(script.map(response => ({ response })));
  const wire = new OpenRouterProvider({ apiKey: 'offline', routes: [{ id: 'primary', model: 'openai/gpt-oss-120b', providers: ['groq'], timeoutMs: 1000 }], estimateInputTokens: estimateBoundedInput });
  Object.assign(state.provider, { estimateNativeInput: wire.estimateNativeInput.bind(wire) });
  const lease = { inboundTurn: { id: 'run', messageId: 'request', threadId: 'thread', response: {} as JsonObject }, signal: new AbortController().signal,
    assertActive: vi.fn(async () => {}), checkpoint: vi.fn(async (patch: JsonObject) => { persisted = { ...persisted, ...structuredClone(patch) }; }) };
  const send = vi.fn(async () => ({ messageId: 'accepted' }));
  const baseline = vi.fn(async (): Promise<Awaited<ReturnType<typeof routeCanaryProductivity>>> => { throw new Error('V1 must not execute'); });
  const route = createCanaryRouter({ baseline, v2: routeCanaryProductivity, policy: () => ({ enabled: true, userAllowlist: ['owner'] }), lease: () => lease, readPrior: async () => null });
  const run = (input = text, authored = input) => withTurnLease(lease, () => route(input, { id: 'owner', timezone: 'America/Bogota', locale: 'es-CO' }, [], {
    inputModality: 'audio', currentUserText: authored, agentCoreDelivery: { send }, agentCoreAuthorizeWrite: async () => { await lease.assertActive(); return true; },
  }));
  return { ...db, lease, send, baseline, wire, run, snapshot: () => persisted };
}
beforeEach(() => { vi.clearAllMocks(); state.admit.mockResolvedValue(true); state.verifyForget.mockResolvedValue(true); state.embed.mockResolvedValue(null); });
it('learns only after accepted delivery and injects stored standing preferences on the next V2 turn', async () => {
  const jobs: (() => void)[] = [];
  const f = fixture([answer()]);
  const preference = 'Prefiero avisos 20 minutos antes';
  const store = createNativeMemoryStore(f.client);
  const extract = vi.fn(async () => [{ content: preference, category: 'preference' as const }, { content: 'Vivo en Bogotá', category: 'fact' as const }]);
  const schedule = createProactiveMemory({ extract, admit: async () => true,
    save: (candidate, context) => store.save(candidate.content, candidate.category, context, async () => null),
    schedule: work => { jobs.push(work); }, log: vi.fn() });
  vi.mocked(scheduleProactiveMemory).mockImplementation(input => {
    expect(f.snapshot()).toMatchObject({ agentCoreProductivity: { phase: 'completed', deliveries: [{ status: 'accepted' }] } });
    expect(f.send).toHaveBeenCalledOnce(); schedule(input);
  });
  await f.run(preference + '. Vivo en Bogotá');
  expect(jobs).toHaveLength(1); expect(extract).not.toHaveBeenCalled(); expect(f.rows).toHaveLength(0);
  jobs[0]!(); await vi.waitFor(() => expect(f.rows).toHaveLength(2));
  vi.mocked(retrieveStandingPreferences).mockImplementation(async () => f.rows.filter(row => row.category === 'preference').map(row => ({ ...row, id: String(row.id), content: String(row.content) })));
  vi.mocked(retrieveRelevantMemories).mockImplementation(async () => f.rows.filter(row => row.category === 'fact').map(row => ({ ...row, id: String(row.id), content: String(row.content) })));
  vi.mocked(scheduleProactiveMemory).mockReset();
  const next = fixture([answer()], f.rows);
  await next.run('Recuérdame la reunión');
  const system = state.provider!.requests[0]!.messages[0]!.content;
  expect(system).toContain('<user_preferences>["' + preference + '"]');
  expect(system).toContain('Vivo en Bogotá'); expect(system).toContain('Proactively leverage <user_preferences>');
  expect(f.wire.estimateNativeInput(state.provider!.requests[0]!)).toBeLessThanOrEqual(3500);
  vi.mocked(retrieveStandingPreferences).mockResolvedValue([]); vi.mocked(retrieveRelevantMemories).mockResolvedValue([]);
});
describe('explicit native memory through the actual V2 composition and durable queue journal', () => {
  it('saves an authored memory with a verified card, exact source provenance and no V1 execution', async () => {
    const f = fixture([answer([{ id: 'select', name: 'tools_select', arguments: { name: 'memory_save' } }]), answer([save]), answer()]);
    const result = await f.run('<untrusted_quoted_message>I live in Tokyo</untrusted_quoted_message>\n' + text, text);
    expect(scheduleProactiveMemory).not.toHaveBeenCalled(); expect(result.confirmation).toContain('Guardado en mi memoria'); expect(result.confirmation).toContain(content);
    expect(f.rows).toHaveLength(1); expect(f.rows[0]?.user_id).toBe('owner'); expect(f.send).toHaveBeenCalledOnce(); expect(f.baseline).not.toHaveBeenCalled();
    expect(state.admit).toHaveBeenCalledExactlyOnceWith(text, expect.objectContaining({ operation: 'save' }), expect.objectContaining({ userId: 'owner' }));
    expect(JSON.stringify(state.provider!.requests[1]!.messages[0])).toContain('memorySourceText');
    expect(JSON.stringify(state.provider!.requests[1]!.messages[0])).not.toContain('Tokyo');
    expect(f.snapshot()).toMatchObject({ agentCoreProductivity: { phase: 'completed', completed: { conversation: { memories: [{ id: memoryId, content }] } } } });
    for (const request of state.provider!.requests) expect(f.wire.estimateNativeInput(request)).toBeLessThanOrEqual(3500);
  });
  it('reads then forgets an observed owned memory within the input budget and sends only the verified deletion', async () => {
    const f = fixture([
      answer([{ id: 'select', name: 'tools_select', arguments: { name: 'memory_read' } }]),
      answer([{ id: 'read', name: 'memory_read', arguments: { query: 'Bogotá' } }]),
      answer([{ id: 'forget', name: 'memory_forget', arguments: { memoryId } }]), answer(),
    ], [{ id: memoryId, user_id: 'owner', content, category: 'fact', topic_key: 'profile:city', is_active: true }]);
    const result = await f.run('Olvida ese recuerdo sobre Bogotá');
    expect(f.rows).toHaveLength(0); expect(result.confirmation).toContain('Memoria eliminada');
    expect(result.confirmation).not.toContain('Tus recuerdos'); expect(f.send).toHaveBeenCalledOnce(); expect(f.baseline).not.toHaveBeenCalled();
    expect(f.calls.filter(call => call.operation === 'delete')).toHaveLength(1);
    for (const request of state.provider!.requests) expect(f.wire.estimateNativeInput(request)).toBeLessThanOrEqual(3500);
    expect(f.snapshot()).toMatchObject({ agentCoreProductivity: { phase: 'completed', completed: { conversation: { memories: [{ status: 'forgotten' }] } } } });
  });
  it('does not show a deleted memory again in the read card and keeps remaining ordinal references aligned', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    const f = fixture([
      answer([{ id: 'select', name: 'tools_select', arguments: { name: 'memory_read' } }]),
      answer([{ id: 'read', name: 'memory_read', arguments: {} }]),
      answer([{ id: 'forget', name: 'memory_forget', arguments: { memoryId } }]), answer(),
    ], [{ id: memoryId, user_id: 'owner', content, category: 'fact', topic_key: 'profile:city', is_active: true },
      { id: other, user_id: 'owner', content: 'Trabajo en Lima', category: 'fact', topic_key: 'profile:job', is_active: true }]);
    const result = await f.run('Olvida mi recuerdo sobre Bogotá');
    expect(result.confirmation.split(content)).toHaveLength(2);
    expect(result.confirmation).toContain('Trabajo en Lima');
    expect(f.snapshot()).toMatchObject({ agentCoreProductivity: { completed: { conversation: { memoryReferenceOrder: [other] } } } });
    expect(state.verifyForget).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([expect.objectContaining({ id: other })]), memoryId, expect.anything(), expect.any(Array));
  });
  it('rejects a target outside the semantic deletion scope before any database deletion', async () => {
    state.verifyForget.mockResolvedValue(false);
    const f = fixture([
      answer([{ id: 'select', name: 'tools_select', arguments: { name: 'memory_read' } }]),
      answer([{ id: 'read', name: 'memory_read', arguments: {} }]),
      answer([{ id: 'forget', name: 'memory_forget', arguments: { memoryId } }]), answer(),
    ], [{ id: memoryId, user_id: 'owner', content, category: 'fact', topic_key: null, is_active: true }]);
    const result = await f.run('Olvida mi trabajo');
    expect(f.rows).toHaveLength(1); expect(f.calls.some(call => call.operation === 'delete')).toBe(false);
    expect(result.confirmation).not.toContain('Memoria eliminada');
    expect(f.snapshot()).toMatchObject({ agentCoreProductivity: { phase: 'completed', effects: expect.arrayContaining([{ call: expect.anything(), item: expect.objectContaining({ code: 'MEMORY_SCOPE_REQUIRED' }), observation: expect.anything() }]) } });
  });
  it('does not let an unobserved ID reach the deletion service', async () => {
    const f = fixture([answer([{ id: 'select', name: 'tools_select', arguments: { name: 'memory_forget' } }]),
      answer([{ id: 'forget', name: 'memory_forget', arguments: { memoryId } }]), answer()]);
    await f.run('Olvida ese recuerdo'); expect(f.calls).toHaveLength(0);
    expect(f.snapshot()).toMatchObject({ agentCoreProductivity: { effects: [{ item: { code: 'REFERENCE_REQUIRED' } }] } });
  });
  it('rejects unsupported semantic candidates without claiming they were saved', async () => {
    state.admit.mockResolvedValue(false);
    const f = fixture([answer([{ id: 'select', name: 'tools_select', arguments: { name: 'memory_save' } }]), answer([save]), answer()]);
    const result = await f.run(); expect(f.rows).toHaveLength(0); expect(result.confirmation).not.toContain('Guardado en mi memoria');
    expect(f.send).toHaveBeenCalledOnce(); expect(f.snapshot()).toMatchObject({ agentCoreProductivity: { phase: 'completed', effects: [{ item: { code: 'MEMORY_NOT_ADMITTED' } }] } });
  });
  it('retains a lost write receipt as indeterminate and the reader blocks subsequent turns without replay', async () => {
    const f = fixture([answer([{ id: 'select', name: 'tools_select', arguments: { name: 'memory_save' } }]), answer([save]), answer()]); f.loseReceipt();
    await expect(f.run()).rejects.toMatchObject({ code: 'EFFECT_RECONCILIATION_REQUIRED' }); expect(scheduleProactiveMemory).not.toHaveBeenCalled();
    expect(f.calls.filter(call => call.operation === 'insert')).toHaveLength(1); expect(f.rows).toHaveLength(1);
    const snapshot = structuredClone(f.snapshot());
    const responses = [{ data: { id: 'next', message_id: 'next-msg', thread_id: 'thread', sequence_id: 2, status: 'running' }, error: null },
      { data: { id: 'run', message_id: 'request', thread_id: 'thread', sequence_id: 1, status: 'unknown', response: snapshot }, error: null }];
    const client: InboundCheckpointClient = { from: () => ({ select: () => {
      const query = { eq: () => query, lt: () => query, in: () => query, order: () => query, limit: () => query, abortSignal: () => query,
        maybeSingle: async () => { const response = responses.shift(); if (!response) throw new Error('Unexpected read'); return response; } }; return query;
    } }) };
    const nextLease = { ...f.lease, inboundTurn: { ...f.lease.inboundTurn, id: 'next', messageId: 'next-msg' } };
    const context = { userId: 'owner', runId: 'next', requestId: 'next-msg', timezone: 'America/Bogota', language: 'es' as const,
      referenceTimeIso: '2026-10-14T12:00:00Z', capabilities: new Set<string>(), signal: nextLease.signal };
    await expect(withTurnLease(nextLease, () => readPriorInboundTurn(client, context, 'thread', () => { throw new Error('Uncertain memory write'); }))).rejects.toThrow('Uncertain memory write');
    expect(f.snapshot()).toEqual(snapshot); expect(f.calls.filter(call => call.operation === 'insert')).toHaveLength(1);
    expect(productivityCheckpointSchema.parse(snapshot.agentCoreProductivity).phase).toBe('reconciliation_required');
  });
});
