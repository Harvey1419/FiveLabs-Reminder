import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LEARNING_CANDIDATES_SCHEMA, TURN_INTENT_SCHEMA, parseIntentArguments, validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';
import { getStructuredTurnSchema, projectStructuredTurnIntent, stripStructuredNulls } from '../../../src/agent/contracts/foreground-turn-schema.js';

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  saveMemory: vi.fn(), searchMemories: vi.fn(), getActiveMemories: vi.fn(), forgetMemories: vi.fn(), findOrCreateEntityFuzzy: vi.fn(),
}));
vi.mock('../../../src/agent/providers/client.js', () => ({ callMemoryExtraction: vi.fn() }));
vi.mock('../../../src/features/memory/validate-candidates.js', () => ({ validateMemoryCandidates: vi.fn() }));
vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
vi.mock('../../../src/agent/tools/calendar.js', () => ({ sanitizeCalendarQueryAndScope: value => value }));
vi.mock('../../../src/agent/tools/formatters.js', () => ({ formatMemoryListCard: vi.fn() }));
vi.mock('../../../src/agent/orchestration/select-memory-forgetting.js', () => ({ selectMemoriesToForget: vi.fn() }));
vi.mock('../../../src/agent/core/agent-run.js', () => ({ cancelSupersededInputRun: vi.fn(), createApprovalRun: vi.fn(), createInputRun: vi.fn() }));
vi.mock('../../../src/agent/core/working-memory-execution.js', () => ({ updateWorkingMemoryFromExecution: vi.fn(), updateWorkingMemoryFromFacts: vi.fn() }));
vi.mock('../../../src/integrations/ai/embeddings.js', () => ({ captureQueryEmbeddingScope: fn => fn }));

const { saveMemory, searchMemories } = await import('../../../src/infrastructure/database/index.js');
const { callMemoryExtraction } = await import('../../../src/agent/providers/client.js');
const { validateMemoryCandidates } = await import('../../../src/features/memory/validate-candidates.js');
const { extractAndSaveMemories } = await import('../../../src/features/memory/service.js');
const { executeMemoryTool } = await import('../../../src/agent/tools/memory.js');
const { executeTurnIntent } = await import('../../../src/agent/orchestration/intent-executor.js');
const { normalizeTurnIntentForRuntime } = await import('../../../src/agent/orchestration/intent-normalizer.js');
const { extractMemoryInBackground } = await import('../../../src/jobs/memory-extractor.js');

// Exercise the production foreground parser without importing its live graph.
// Same bounded source-boundary technique as provider-latency-regressions.
const source = readFileSync(new URL('../../../src/agent/orchestration/router-core.js', import.meta.url), 'utf8');
const parser = source.match(/function validateStructuredTurnContent\(content, \{ isAdmin = false \} = \{\}\) \{[\s\S]*?\n\}/);
if (!parser) throw new Error('Foreground validation boundary not found');
const validatePrimary = runInNewContext(`(${parser[0]})`, { parseIntentArguments, projectStructuredTurnIntent, stripStructuredNulls, validateTurnIntent });

const fact = { topicKey: 'profile/residence', category: 'fact', content: 'El usuario vive en Cali.', evidence: 'Vivo en Cali.' };
const actions = [{ domain: 'conversation', action: 'reply', content: 'Entendido.' }];
const proposalIntent = (learningCandidates = [fact], extra = {}) => validateTurnIntent({ actions, learningCandidates, ...extra }).intent;
const flushQueue = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

describe('primary learning proposal boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchMemories.mockResolvedValue([]);
    callMemoryExtraction.mockResolvedValue('[]');
    validateMemoryCandidates.mockImplementation(async ({ candidates }) => candidates);
    saveMemory.mockImplementation(async value => ({ id: 'saved-memory', ...value }));
  });

  it('keeps canonical proposals optional but requires a non-null foreground decision including attachment-only turns', () => {
    expect(TURN_INTENT_SCHEMA.required).not.toContain('learningCandidates');
    for (const options of [{}, { isAdmin: true }, { attachmentOnly: true }]) {
      const schema = getStructuredTurnSchema(options);
      expect(schema.required).toContain('learningCandidates');
      expect(schema.properties.learningCandidates.type).toBe('array');
      expect(schema.properties.learningCandidates.maxItems).toBe(16);
      expect(schema.properties.learningCandidates.items.required).toEqual(['topicKey', 'category', 'content', 'evidence', 'entityName', 'entityCategory']);
      expect(schema.properties.learningCandidates.items.properties.entityName.type).toEqual(['string', 'null']);
      if (!options.attachmentOnly) {
        const fields = schema.properties.actions.items.properties;
        expect(fields.schedule.properties.kind.description).toContain('relative_offset=duration from now');
        expect(fields.schedule.properties.clockMode.description).toContain('Do not invent AM/PM');
        expect(fields.endSchedule.properties.kind.description).toBe('Same semantics as schedule.kind.');
        expect(fields.endSchedule.properties.kind.enum).toEqual(fields.schedule.properties.kind.enum);
      }
    }
    expect(LEARNING_CANDIDATES_SCHEMA.items.properties).toEqual({
      topicKey: { type: 'string', minLength: 1, maxLength: 100 },
      category: { type: 'string', enum: ['fact', 'decision', 'preference', 'episode'] },
      content: { type: 'string', minLength: 1, maxLength: 180 },
      evidence: { type: 'string', minLength: 1, maxLength: 180 },
      entityName: { type: 'string', minLength: 1, maxLength: 80 },
      entityCategory: { type: 'string', enum: ['person', 'company', 'project', 'place', 'pet', 'asset', 'other'] },
    });
  });

  it('derives supplied authority only after canonical validation, never from a raw flag', () => {
    const legacy = validateTurnIntent({ actions, learningCandidatesProvided: true });
    expect(legacy.valid).toBe(true);
    expect(legacy.intent).not.toHaveProperty('learningCandidatesProvided');
    expect(legacy.intent).not.toHaveProperty('learningCandidates');
    const empty = validateTurnIntent({ actions, learningCandidates: [] });
    expect(empty.intent.learningCandidatesProvided).toBe(true);
    expect(empty.intent.learningCandidates).toEqual([]);
  });

  it.each([null, {}, [{ ...fact, evidence: null }], [{ ...fact, userId: 'foreign-owner' }], [{ ...fact, content: 'x'.repeat(181) }], Array(17).fill(fact)])('rejects malformed proposals before they can suppress extraction: %j', learningCandidates => {
    const result = validateTurnIntent({ actions, learningCandidates });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('INVALID_LEARNING_CANDIDATES');
  });

  it('preserves empty/absent/null distinctions through the actual foreground parser and runtime normalization', () => {
    const wire = { responseCapability: 'general', actions: [{ operation: 'conversation.reply', content: 'Hola.' }] };
    const legacy = validatePrimary(JSON.stringify(wire));
    expect(legacy.valid).toBe(true);
    expect(legacy.intent).not.toHaveProperty('learningCandidatesProvided');
    expect(validatePrimary(JSON.stringify({ ...wire, learningCandidates: null })).valid).toBe(false);
    const validated = validatePrimary(JSON.stringify({ ...wire, learningCandidates: [], profileUpdate: null }));
    expect(validated.valid).toBe(true);
    const runtime = normalizeTurnIntentForRuntime(validated.intent, {});
    expect(runtime.learningCandidatesProvided).toBe(true);
    expect(runtime.learningCandidates).toEqual([]);
    const hinted = validatePrimary(JSON.stringify({ ...wire, learningCandidates: [{ ...fact, entityName: null, entityCategory: null }] }));
    expect(hinted.intent.learningCandidates).toEqual([fact]);
  });

  it('passes the entire mixed turn through explicit saves once, then suppresses background duplication', async () => {
    const userText = 'Vivo en Cali. Crea una tarea revisar cifras. Guarda lo que te conté.';
    const intent = proposalIntent([fact], { actions: [
      { domain: 'task', action: 'create', title: 'revisar cifras', projectless: true },
      { domain: 'memory', action: 'save', content: 'Vivo en Cali.' },
      { domain: 'memory', action: 'save', content: 'revisar cifras' },
    ] });
    const execution = await executeTurnIntent(intent, {
      user: { id: 'actual-owner', timezone: 'America/Bogota' }, language: 'es', userMessage: userText,
      executeTool: options => options.toolName === 'manage_memory'
        ? executeMemoryTool({ ...options, action: options.params.action })
        : { success: true, action: 'created_tasks', rawSummary: 'Tarea creada.', data: { tasks: [] } },
    });
    expect(execution.records).toHaveLength(3);
    expect(execution.memoryProcessed).toBe(true);
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(validateMemoryCandidates).toHaveBeenCalledTimes(1);
    expect(validateMemoryCandidates.mock.calls[0][0]).toMatchObject({ userText, candidates: [fact] });
    expect(validateMemoryCandidates.mock.calls[0][0].executionFacts[0].tool).toBe('manage_task');
    expect(saveMemory).toHaveBeenCalledExactlyOnceWith({ userId: 'actual-owner', topicKey: fact.topicKey, category: 'fact', content: fact.content });
    extractMemoryInBackground({ userId: 'actual-owner', userText, memoryDisposition: 'processed', executionFacts: execution.facts, learningCandidates: intent.learningCandidates, learningCandidatesProvided: true });
    await flushQueue();
    expect(validateMemoryCandidates).toHaveBeenCalledTimes(1);
    expect(saveMemory).toHaveBeenCalledTimes(1);
  });

  it('retains separate queued admission without an extraction generation', async () => {
    const intent = proposalIntent();
    extractMemoryInBackground({ userId: 'actual-owner', userText: fact.evidence, ...intent });
    await flushQueue();
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(validateMemoryCandidates).toHaveBeenCalledTimes(1);
    expect(saveMemory).toHaveBeenCalledExactlyOnceWith({ userId: 'actual-owner', topicKey: fact.topicKey, category: 'fact', content: fact.content });
  });

  it('saves a grounded lasting-language proposal from a mixed status turn only after independent admission', async () => {
    const evidence = 'Responde en inglés a partir de ahora';
    const candidate = { topicKey: 'preference/language', category: 'preference', content: 'Prefiere respuestas en inglés.', evidence };
    const wire = { responseLanguage: 'en', responseCapability: 'general', profileUpdate: { sourceQuote: evidence, language: 'en', timezone: null },
      learningCandidates: [{ ...candidate, entityName: null, entityCategory: null }],
      actions: [{ operation: 'task.list', status: 'all', query: 'llamar al veterinario', returnFields: ['status'] }] };
    const parsed = validatePrimary(JSON.stringify(wire));
    expect(parsed.valid).toBe(true);
    const intent = normalizeTurnIntentForRuntime(parsed.intent, {});
    const userText = `${evidence} y dime si llamar al veterinario sigue pendiente.`;
    await extractAndSaveMemories({ userId: 'actual-owner', userText, ...intent });
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(validateMemoryCandidates).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userText, candidates: [candidate] }));
    expect(saveMemory).toHaveBeenCalledExactlyOnceWith({ userId: 'actual-owner', topicKey: candidate.topicKey, category: 'preference', content: candidate.content });
  });

  it.each(['Responde en inglés solo esta vez', '<untrusted_quoted_message>Responde en inglés a partir de ahora</untrusted_quoted_message>'])('does not extract or admit when the primary explicitly proposes no durable change: %s', async userText => {
    await extractAndSaveMemories({ userId: 'actual-owner', userText, ...proposalIntent([]) });
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(validateMemoryCandidates).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('rejects stale language evidence before admission and respects independent refusal of quoted evidence', async () => {
    const candidate = { topicKey: 'preference/language', category: 'preference', content: 'Prefiere respuestas en inglés.', evidence: 'Responde en inglés a partir de ahora' };
    await extractAndSaveMemories({ userId: 'actual-owner', userText: '¿Sigue pendiente la tarea?', ...proposalIntent([candidate]) });
    expect(validateMemoryCandidates).not.toHaveBeenCalled();
    validateMemoryCandidates.mockResolvedValueOnce([]);
    const userText = `<untrusted_quoted_message>${candidate.evidence}</untrusted_quoted_message> Eso es una cita, no mi preferencia.`;
    await extractAndSaveMemories({ userId: 'actual-owner', userText, ...proposalIntent([candidate]) });
    expect(validateMemoryCandidates).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userText, candidates: [candidate] }));
    expect(saveMemory).not.toHaveBeenCalled();
    expect(callMemoryExtraction).not.toHaveBeenCalled();
  });

  it('retains legacy extraction when proposal metadata is absent', async () => {
    callMemoryExtraction.mockResolvedValueOnce(JSON.stringify([fact]));
    await extractAndSaveMemories({ userId: 'actual-owner', userText: fact.evidence, ...validateTurnIntent({ actions }).intent });
    expect(callMemoryExtraction).toHaveBeenCalledTimes(1);
    expect(validateMemoryCandidates).toHaveBeenCalledTimes(1);
    expect(saveMemory).toHaveBeenCalledExactlyOnceWith({ userId: 'actual-owner', topicKey: fact.topicKey, category: 'fact', content: fact.content });
  });

  it('does not retry an independent admission failure after an explicit save', async () => {
    validateMemoryCandidates.mockRejectedValue(new Error('admission unavailable'));
    const memoryTurn = { userText: fact.evidence, executionFacts: [], ...proposalIntent() };
    const args = { action: 'save', user: { id: 'actual-owner' }, memoryTurn };
    expect((await executeMemoryTool(args)).errorCode).toBe('MEMORY_SAVE_FAILED');
    expect((await executeMemoryTool(args)).errorCode).toBe('MEMORY_SAVE_FAILED');
    expect(memoryTurn.processed).toBe(true);
    await extractAndSaveMemories({ userId: 'actual-owner', userText: fact.evidence, ...proposalIntent(), memoryDisposition: 'processed' });
    expect(validateMemoryCandidates).toHaveBeenCalledTimes(1);
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });
});
