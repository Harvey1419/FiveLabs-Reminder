import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  saveMemory: vi.fn(),
  searchMemories: vi.fn(),
  findOrCreateEntityFuzzy: vi.fn(),
}));

vi.mock('../../../src/agent/providers/client.js', () => ({
  callMemoryExtraction: vi.fn(),
}));

const { saveMemory, searchMemories, findOrCreateEntityFuzzy } = await import('../../../src/infrastructure/database/index.js');
const { callMemoryExtraction } = await import('../../../src/agent/providers/client.js');
const { extractAndSaveMemories, getMemoryEligibleText } = await import('../../../src/features/memory/service.js');
vi.mock('../../../src/features/memory/validate-candidates.js', () => ({ validateMemoryCandidates: vi.fn() }));
const { validateMemoryCandidates } = await import('../../../src/features/memory/validate-candidates.js');

const reminderFact = {
  tool: 'manage_reminder',
  success: true,
  card: '✅ Recordatorios programados: llevar a mi amorcito en 10 minutos; decirle que la amo en 20 minutos; cita de Borona a las 4 de la tarde.',
  summary: '',
};

const proposedFact = {
  topicKey: 'profile/residence', category: 'fact',
  content: 'El usuario vive en Cali.', evidence: 'Vivo en Cali.',
};

describe('durable memory extraction policy', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    callMemoryExtraction.mockResolvedValue('[]');
    validateMemoryCandidates.mockImplementation(async ({ candidates }) => candidates);
    searchMemories.mockResolvedValue([]);
    findOrCreateEntityFuzzy.mockImplementation(async ({ userId, name, category }) => ({ id: 'entity-1', user_id: userId, name, category }));
    saveMemory.mockResolvedValue({ id: 'memory-1' });
  });

  it('uses the legacy extractor only when there is no validated proposal decision', async () => {
    callMemoryExtraction.mockResolvedValue(JSON.stringify([proposedFact]));
    await extractAndSaveMemories({ userId: 'user-1', userText: proposedFact.evidence });
    expect(callMemoryExtraction).toHaveBeenCalledTimes(1);
    expect(validateMemoryCandidates).toHaveBeenCalledTimes(1);
    expect(saveMemory).toHaveBeenCalledExactlyOnceWith({ userId: 'user-1', topicKey: proposedFact.topicKey, category: 'fact', content: proposedFact.content });
  });

  it('uses zero extraction, admission or lookup calls for an explicit empty proposal decision', async () => {
    expect(await extractAndSaveMemories({ userId: 'user-1', userText: 'Gracias.', learningCandidates: [], learningCandidatesProvided: true })).toEqual([]);
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(validateMemoryCandidates).not.toHaveBeenCalled();
    expect(searchMemories).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('independently admits a grounded proposal even alongside an unfinished operation', async () => {
    const userText = 'Vivo en Cali. Recuérdame mi cita mañana.';
    expect(await extractAndSaveMemories({ userId: 'user-1', userText, learningCandidates: [proposedFact], learningCandidatesProvided: true, memoryDisposition: 'skip_operational' })).toHaveLength(1);
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(validateMemoryCandidates).toHaveBeenCalledExactlyOnceWith({ userText, candidates: [proposedFact], executionFacts: [], throwOnError: false });
    expect(saveMemory).toHaveBeenCalledExactlyOnceWith({ userId: 'user-1', topicKey: 'profile/residence', category: 'fact', content: proposedFact.content });
  });

  it.each([
    ['not quoted in current source', 'Hola.', 'Vivo en Cali.'],
    ['assistant only', 'Hola.', 'Vivo en Cali.'],
    ['attachment only', '<untrusted_attachment_content>Vivo en Cali.</untrusted_attachment_content>', 'Vivo en Cali.'],
    ['untrusted attachment with caption', 'Mira esto. <untrusted_attachment_content>Vivo en Cali.</untrusted_attachment_content>', 'Vivo en Cali.'],
    ['prior turn only', 'Ahora vivo en Bogotá.', 'Vivo en Cali.'],
  ])('rejects %s before admission without another extraction', async (_case, userText, evidence) => {
    expect(await extractAndSaveMemories({ userId: 'user-1', userText, assistantReply: 'Vivo en Cali.', learningCandidates: [{ ...proposedFact, evidence }], learningCandidatesProvided: true })).toEqual([]);
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(validateMemoryCandidates).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('keeps full quoted attribution context for independent admission and respects rejection', async () => {
    const userText = 'Mi colega dijo "Vivo en Cali."; no soy yo.';
    validateMemoryCandidates.mockResolvedValue([]);
    expect(await extractAndSaveMemories({ userId: 'user-1', userText, learningCandidates: [proposedFact], learningCandidatesProvided: true })).toEqual([]);
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(validateMemoryCandidates).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userText, candidates: [proposedFact] }));
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it.each([null, {}, [{ ...proposedFact, userId: 'foreign-owner' }]])('does not let a raw flag with malformed metadata suppress legacy extraction: %j', async learningCandidates => {
    await extractAndSaveMemories({ userId: 'user-1', userText: proposedFact.evidence, learningCandidates, learningCandidatesProvided: true });
    expect(callMemoryExtraction).toHaveBeenCalledTimes(1);
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('preserves absent-metadata extraction even with complete explicit save fields', async () => {
    callMemoryExtraction.mockResolvedValue(JSON.stringify([proposedFact]));
    await extractAndSaveMemories({ userId: 'user-1', userText: proposedFact.evidence, memorySaveActions: [{ domain: 'memory', action: 'save', ...proposedFact, content: proposedFact.evidence }] });
    expect(callMemoryExtraction).toHaveBeenCalledTimes(1);
    expect(validateMemoryCandidates).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ candidates: [proposedFact] }));
  });

  it('does not repair invalid foreign-owner learning metadata with explicit action fields', async () => {
    await extractAndSaveMemories({ userId: 'user-1', userText: proposedFact.evidence, learningCandidates: [{ ...proposedFact, userId: 'foreign-owner' }], learningCandidatesProvided: true, memorySaveActions: [{ domain: 'memory', action: 'save', ...proposedFact, content: proposedFact.evidence }] });
    expect(callMemoryExtraction).toHaveBeenCalledTimes(1);
    expect(validateMemoryCandidates).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('accepts all sixteen distinct merged candidates at the existing cap', async () => {
    const facts = Array.from({ length: 15 }, (_, index) => ({ topicKey: `profile/aspect_${index}`, category: 'fact', content: `Dato ${index}.`, evidence: `Dato ${index}.` }));
    const action = { domain: 'memory', action: 'save', topicKey: 'preference/style', category: 'preference', content: 'Prefiero respuestas breves.' };
    await extractAndSaveMemories({ userId: 'user-1', userText: [...facts.map(item => item.evidence), action.content].join(' '), learningCandidates: facts, learningCandidatesProvided: true, memorySaveActions: [action, action], throwOnError: true });
    expect(validateMemoryCandidates).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ candidates: [...facts, { topicKey: action.topicKey, category: action.category, content: action.content, evidence: action.content }] }));
    expect(saveMemory).toHaveBeenCalledTimes(16);
    expect(callMemoryExtraction).not.toHaveBeenCalled();
  });

  it('fails a merged batch above sixteen visibly rather than dropping later actions or facts', async () => {
    const facts = Array.from({ length: 16 }, (_, index) => ({ topicKey: `profile/aspect_${index}`, category: 'fact', content: `Dato ${index}.`, evidence: `Dato ${index}.` }));
    const action = { domain: 'memory', action: 'save', topicKey: 'preference/style', category: 'preference', content: 'Prefiero respuestas breves.' };
    await expect(extractAndSaveMemories({ userId: 'user-1', userText: [...facts.map(item => item.evidence), action.content].join(' '), learningCandidates: facts, learningCandidatesProvided: true, memorySaveActions: [action], throwOnError: true })).rejects.toThrow('Memory proposal batch exceeds the candidate limit.');
    expect(validateMemoryCandidates).not.toHaveBeenCalled();
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('uses only the authenticated owner and does not adopt a foreign entity result', async () => {
    findOrCreateEntityFuzzy.mockResolvedValue({ user_id: 'foreign-owner', category: 'company', name: 'Foreign name' });
    const candidate = { topicKey: 'company/acme/relation', category: 'fact', content: 'Trabaja con Acme.', evidence: 'Trabajo con Acme.', entityName: 'Acme', entityCategory: 'company' };
    await extractAndSaveMemories({ userId: 'user-1', userText: candidate.evidence, learningCandidates: [candidate], learningCandidatesProvided: true });
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(findOrCreateEntityFuzzy).toHaveBeenCalledExactlyOnceWith({ userId: 'user-1', name: 'Acme', category: 'company' });
    expect(saveMemory).toHaveBeenCalledExactlyOnceWith({ userId: 'user-1', topicKey: candidate.topicKey, category: 'fact', content: candidate.content });
  });

  it('does not retry admission or extraction after a processed explicit save', async () => {
    await extractAndSaveMemories({ userId: 'user-1', userText: proposedFact.evidence, learningCandidates: [proposedFact], learningCandidatesProvided: true, memoryDisposition: 'processed' });
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(validateMemoryCandidates).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it.each([42, { key: 'profile/residence' }, '!!!', 'residence', 'profile/___/home', 'profile/' + 'x'.repeat(101)])('rejects malformed topic identity %j before entity and memory writes', async topicKey => {
    const userText = 'Vivo en Cali.';
    callMemoryExtraction.mockResolvedValue(JSON.stringify([{ topicKey, category: 'fact', content: userText, evidence: userText, entityName: 'Cali' }]));
    expect(await extractAndSaveMemories({ userId: 'user-1', userText })).toEqual([]);
    expect(findOrCreateEntityFuzzy).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });
  it('rejects only a malformed identity while preserving a valid durable preference', async () => {
    const userText = 'Vivo en Cali. Prefiero llamadas telefónicas.';
    callMemoryExtraction.mockResolvedValue(JSON.stringify([
      { topicKey: '!!!', category: 'fact', content: 'Vivo en Cali.', evidence: 'Vivo en Cali.', entityName: 'Cali' },
      { topicKey: 'preference/communication/channel', category: 'preference', content: 'Prefiere llamadas telefónicas.', evidence: 'Prefiero llamadas telefónicas.' },
    ]));
    const saved = await extractAndSaveMemories({ userId: 'user-1', userText });
    expect(saved).toHaveLength(1);
    expect(findOrCreateEntityFuzzy).not.toHaveBeenCalled();
    expect(saveMemory).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ topicKey: 'preference/communication/channel' }));
    expect(validateMemoryCandidates).toHaveBeenCalledWith(expect.objectContaining({ candidates: [expect.objectContaining({ topicKey: 'preference/communication/channel' })] }));
  });
  it.each([
    ['Borona', 'pet'], ['Borona', 'preference'], ['Borona', null], ['Borona', undefined],
    ['Borona', { type: 'person' }], [42, 'person'], [{ name: 'Borona' }, 'person'],
    [[], 'person'], ['   ', 'person'], [null, 'person'],
  ])('saves admitted fact without unsupported optional identity %j/%j', async (entityName, entityCategory) => {
    const userText = 'Borona es mi perrita.';
    callMemoryExtraction.mockResolvedValue(JSON.stringify([{ topicKey: 'pet/borona/relation', category: 'fact', content: userText, evidence: userText, entityName, entityCategory }]));
    expect(await extractAndSaveMemories({ userId: 'user-1', userText, throwOnError: true })).toHaveLength(1);
    expect(findOrCreateEntityFuzzy).not.toHaveBeenCalled();
    expect(saveMemory).toHaveBeenCalledExactlyOnceWith({ userId: 'user-1', topicKey: 'pet/borona/relation', category: 'fact', content: userText });
  });
  it.each(['person', 'company'])('attempts valid owned %s association without rewriting the fact identity', async entityCategory => {
    const userText = 'Trabajo con Acme.';
    callMemoryExtraction.mockResolvedValue(JSON.stringify([{ topicKey: 'company/acme/relation', category: 'fact', content: userText, evidence: userText, entityName: ' Acme ', entityCategory }]));
    await extractAndSaveMemories({ userId: 'user-1', userText });
    expect(findOrCreateEntityFuzzy).toHaveBeenCalledExactlyOnceWith({ userId: 'user-1', name: 'Acme', category: entityCategory });
    expect(saveMemory).toHaveBeenCalledExactlyOnceWith({ userId: 'user-1', topicKey: 'company/acme/relation', category: 'fact', content: userText });
  });
  it('keeps a durable fact independent of a conflicting known physical category', async () => {
    const userText = 'Acme es mi empresa.';
    const readConflictingName = vi.fn(() => 'Unrelated person');
    findOrCreateEntityFuzzy.mockResolvedValue({ id: 'wrong-category', user_id: 'user-1', get name() { return readConflictingName(); }, category: 'person' });
    callMemoryExtraction.mockResolvedValue(JSON.stringify([{ topicKey: 'company/acme/relation', category: 'fact', content: userText, evidence: userText, entityName: 'Acme', entityCategory: 'company' }]));
    expect(await extractAndSaveMemories({ userId: 'user-1', userText })).toHaveLength(1);
    expect(readConflictingName).not.toHaveBeenCalled();
    expect(saveMemory).toHaveBeenCalledExactlyOnceWith({ userId: 'user-1', topicKey: 'company/acme/relation', category: 'fact', content: userText });
  });
  it('exposes language inference safeguards with source-only full-turn evidence', async () => {
    const userText = 'Mi colega dijo "responde en inglés"; no es mi instrucción. No cambies mi idioma.';
    await extractAndSaveMemories({ userId: 'user-1', userText, assistantReply: 'Untrusted alternative language preference.' });
    const [messages] = callMemoryExtraction.mock.calls[0];
    expect(messages[0].content).toContain('current utterance language, citation, denial or refusal to change');
    expect(messages[0].content).toContain('unnamed alternative language');
    expect(messages[1].content).toContain(`<user_text>${userText}</user_text>`);
    expect(messages[1].content).not.toContain('Untrusted alternative');
  });
  it('preserves embedded assertions in questions for semantic admission', () => {
    expect(getMemoryEligibleText('¿Recuerdas que vivo en Cali?')).toBe('¿Recuerdas que vivo en Cali?');
  });

  it('skips a turn whose clauses were fully consumed by operational tools', async () => {
    const userText = 'Recuérdame llevar a mi amorcito en 10 minutos. Dile que la amo en 20 minutos. Tenemos cita con Borona a las 4 de la tarde.';

    expect(getMemoryEligibleText(userText, [reminderFact])).toBe(userText);
    const saved = await extractAndSaveMemories({
      userId: 'user-1', userText, assistantReply: 'Todo quedó programado.', executionFacts: [reminderFact],
    });

    expect(saved).toEqual([]);
    expect(callMemoryExtraction).toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('does not turn cancelled reminder subjects into projects or entities', async () => {
    const userText = 'Cancela ir al trabajo, la reunión y preparar la cena.';
    const cancellationFact = {
      tool: 'manage_reminder',
      success: true,
      card: 'Recordatorios cancelados: Ir al trabajo; reunión; preparar la cena.',
      summary: '',
    };

    const saved = await extractAndSaveMemories({
      userId: 'user-1', userText, assistantReply: 'Cancelados.', executionFacts: [cancellationFact],
    });

    expect(saved).toEqual([]);
    expect(callMemoryExtraction).toHaveBeenCalled();
    expect(findOrCreateEntityFuzzy).not.toHaveBeenCalled();
  });

  it('rejects a mixed candidate through semantic admission before any writes', async () => {
    validateMemoryCandidates.mockResolvedValue([]);
    const userText = 'Borona es mi perrita. Recuérdame su cita mañana a las 4.';
    const fact = {
      ...reminderFact,
      card: 'Recordatorio programado: cita de Borona mañana a las 4.',
    };
    callMemoryExtraction.mockResolvedValue(JSON.stringify([{
      topicKey: 'pet/borona/health',
      category: 'fact',
      content: 'Borona es la perrita del usuario y mañana tiene una cita a las 4.',
      evidence: 'Recuérdame su cita mañana a las 4.',
      entityName: 'Borona',
      entityCategory: 'pet',
    }]));

    const saved = await extractAndSaveMemories({
      userId: 'user-1', userText, assistantReply: 'Cita programada.', executionFacts: [fact],
    });

    expect(saved).toEqual([]);
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('preserves a durable residual fact even when the same turn executed an operational action', async () => {
    const userText = 'Borona es mi perrita. Recuérdame su cita mañana a las 4.';
    const fact = {
      ...reminderFact,
      card: 'Recordatorio programado: cita de Borona mañana a las 4.',
    };
    callMemoryExtraction.mockResolvedValue(JSON.stringify([{
      topicKey: 'pet/borona/relation',
      category: 'fact',
      content: 'Borona es la perrita del usuario.',
      evidence: 'Borona es mi perrita',
      entityName: 'Borona',
      entityCategory: 'pet',
    }]));

    const saved = await extractAndSaveMemories({
      userId: 'user-1',
      userText,
      assistantReply: 'Cita programada.',
      executionFacts: [fact],
      memoryDisposition: 'skip_operational',
    });

    expect(saved).toHaveLength(1);
    expect(saveMemory).toHaveBeenCalledWith(expect.objectContaining({
      topicKey: 'pet/borona/relation',
      content: 'Borona es la perrita del usuario.',
    }));
    const prompt = callMemoryExtraction.mock.calls[0][0];
    expect(prompt[1].content).toContain('Borona es mi perrita');
    expect(prompt[1].content).toContain('Recuérdame su cita mañana a las 4');
    expect(validateMemoryCandidates).toHaveBeenCalledWith(expect.objectContaining({ executionFacts: [fact], userText }));
  });

  it('skips an unfinished appointment turn using semantic orchestration metadata', async () => {
    const saved = await extractAndSaveMemories({
      userId: 'user-1',
      userText: 'Tengo cita en Cerámica Italia en Barranquilla el 9 de septiembre.',
      assistantReply: '¿A qué hora es y con cuánto tiempo de anticipación quieres que te avise?',
      executionFacts: [],
      memoryDisposition: 'skip_operational',
    });

    expect(saved).toEqual([]);
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('does not save new memories when extraction returns no durable candidates after an explicit save', async () => {
    const memoryFact = {
      tool: 'manage_memory',
      success: true,
      card: '🧠 Guardado en mi memoria: Vivo en Barranquilla',
      summary: '',
    };

    const saved = await extractAndSaveMemories({
      userId: 'user-1',
      userText: 'Vivo en Barranquilla',
      assistantReply: 'Lo tendré presente.',
      executionFacts: [memoryFact],
    });

    expect(saved).toEqual([]);
    expect(callMemoryExtraction).toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('persists an atomic durable fact supported by an exact user quote', async () => {
    callMemoryExtraction.mockResolvedValue(JSON.stringify([{
      topicKey: 'pet/borona/relation',
      category: 'fact',
      content: 'Borona es la perrita del usuario.',
      evidence: 'Borona es mi perrita',
      entityName: 'Borona',
      entityCategory: 'pet',
    }]));

    const saved = await extractAndSaveMemories({
      userId: 'user-1', userText: 'Borona es mi perrita.', assistantReply: 'Qué lindo nombre.', executionFacts: [],
    });

    expect(saved).toHaveLength(1);
    expect(saveMemory).toHaveBeenCalledWith(expect.objectContaining({
      topicKey: 'pet/borona/relation',
      content: 'Borona es la perrita del usuario.',
    }));
    const prompt = callMemoryExtraction.mock.calls[0][0];
    expect(prompt[1].content).toContain('Borona es mi perrita');
    expect(prompt[1].content).not.toContain('Qué lindo nombre');
  });

  it('gives the same extractor related active identities so a paraphrase can be omitted', async () => {
    searchMemories.mockResolvedValue([{
      topic_key: 'profile/residence',
      category: 'fact',
      content: 'El usuario vive en Barranquilla.',
    }]);
    callMemoryExtraction.mockResolvedValue('[]');

    const saved = await extractAndSaveMemories({
      userId: 'user-1',
      userText: 'Mi lugar de residencia sigue siendo Barranquilla.',
      assistantReply: 'Entendido.',
    });

    expect(saved).toEqual([]);
    expect(searchMemories).toHaveBeenCalledWith({
      userId: 'user-1',
      query: 'Mi lugar de residencia sigue siendo Barranquilla.',
      limit: 8,
    });
    const input = callMemoryExtraction.mock.calls[0][0][1].content;
    expect(input).toContain('"topicKey":"profile/residence"');
    expect(input).toContain('Mi lugar de residencia sigue siendo Barranquilla.');
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('reuses an existing structured identity for an explicit current update', async () => {
    searchMemories.mockResolvedValue([{
      topic_key: 'profile/work_location',
      category: 'fact',
      content: 'El usuario trabaja en Bucaramanga.',
    }]);
    callMemoryExtraction.mockResolvedValue(JSON.stringify([{
      topicKey: 'profile/work_location',
      category: 'fact',
      content: 'El usuario ahora trabaja en Barranquilla.',
      evidence: 'Ahora estoy trabajando en Barranquilla',
      entityName: null,
      entityCategory: null,
    }]));

    await extractAndSaveMemories({
      userId: 'user-1',
      userText: 'Ahora estoy trabajando en Barranquilla.',
      assistantReply: 'Entendido.',
    });

    expect(saveMemory).toHaveBeenCalledWith(expect.objectContaining({
      topicKey: 'profile/work_location',
      content: 'El usuario ahora trabaja en Barranquilla.',
    }));
  });

  it('rejects a candidate without a structured topic identity', async () => {
    callMemoryExtraction.mockResolvedValue(JSON.stringify([{
      topicKey: '',
      category: 'preference',
      content: 'El usuario prefiere respuestas breves.',
      evidence: 'Prefiero respuestas breves',
      entityName: null,
      entityCategory: null,
    }]));

    const saved = await extractAndSaveMemories({
      userId: 'user-1', userText: 'Prefiero respuestas breves.', assistantReply: 'Entendido.',
    });

    expect(saved).toEqual([]);
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('uses a bounded high-capacity contract for long onboarding turns', async () => {
    const memories = Array.from({ length: 18 }, (_, index) => ({
      topicKey: `preference/workflow/aspect_${index + 1}`,
      category: 'preference',
      content: `Preferencia profesional durable número ${index + 1}.`,
      evidence: `preferencia profesional ${index + 1}`,
      entityName: null,
      entityCategory: null,
    }));
    callMemoryExtraction.mockResolvedValue(JSON.stringify(memories));

    const userText = memories.map((item) => item.evidence).join('. ');
    const saved = await extractAndSaveMemories({
      userId: 'user-1', userText, assistantReply: 'Entendido.', executionFacts: [],
    });

    expect(callMemoryExtraction).toHaveBeenCalledWith(expect.any(Array), {
      temperature: 0,
      max_tokens: 3200,
      timeoutMs: 15000,
    });
    const prompt = callMemoryExtraction.mock.calls[0][0][0].content;
    expect(prompt).toContain('A normal message should usually produce 0 to 3 high-value memories');
    expect(prompt).toContain('Return at most 16 candidates');
    expect(prompt).toContain('content at most 180 characters');
    expect(saved).toHaveLength(16);
    expect(saveMemory).toHaveBeenCalledTimes(16);
  });

  it('skips extraction when a completed operational task matches user completion statement (Issue #68 invariant)', async () => {
    const userText = 'Ya guardé el pasaporte.';
    const completionFact = {
      tool: 'manage_task',
      success: true,
      card: '✅ Tarea completada: Guardar el pasaporte.',
      summary: '',
      presentationParams: {
        action: 'complete',
        target: 'Guardar el pasaporte',
      },
    };

    expect(getMemoryEligibleText(userText, [completionFact])).toBe(userText);
    const saved = await extractAndSaveMemories({
      userId: 'user-1',
      userText,
      assistantReply: 'Listo, marqué la tarea como completada.',
      executionFacts: [completionFact],
    });

    expect(saved).toEqual([]);
    expect(callMemoryExtraction).toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('rejects an ephemeral completion candidate even if extractor produces a candidate (Issue #68 candidate rejection)', async () => {
    validateMemoryCandidates.mockImplementation(async ({ candidates }) => [candidates[1]]);
    const userText = 'Ya guardé el pasaporte. Mi color favorito es el azul.';
    const completionFact = {
      tool: 'manage_task',
      success: true,
      card: '✅ Tarea completada: Guardar el pasaporte.',
      presentationParams: { target: 'Guardar el pasaporte' },
    };

    callMemoryExtraction.mockResolvedValue(JSON.stringify([
      {
        topicKey: 'profile/passport',
        category: 'fact',
        content: 'El usuario ha guardado su pasaporte.',
        evidence: 'Ya guardé el pasaporte',
        entityName: null,
        entityCategory: null,
      },
      {
        topicKey: 'preference/color',
        category: 'preference',
        content: 'El color favorito del usuario es el azul.',
        evidence: 'Mi color favorito es el azul',
        entityName: null,
        entityCategory: null,
      },
    ]));

    const saved = await extractAndSaveMemories({
      userId: 'user-1',
      userText,
      assistantReply: 'Entendido.',
      executionFacts: [completionFact],
    });

    // The admission decision excludes operational state without removing the independent preference.
    expect(saved).toHaveLength(1);
    expect(saveMemory).toHaveBeenCalledTimes(1);
    expect(saveMemory).toHaveBeenCalledWith(expect.objectContaining({
      topicKey: 'preference/color',
      content: 'El color favorito del usuario es el azul.',
    }));
  });
});

