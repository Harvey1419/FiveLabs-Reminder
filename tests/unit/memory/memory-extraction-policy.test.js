import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  saveMemory: vi.fn(),
  searchMemories: vi.fn(),
  findOrCreateEntityFuzzy: vi.fn(),
}));

vi.mock('../../../src/agent/providers/client.js', () => ({
  callMemoryExtraction: vi.fn(),
}));

const { saveMemory, findOrCreateEntityFuzzy } = await import('../../../src/infrastructure/database/index.js');
const { callMemoryExtraction } = await import('../../../src/agent/providers/client.js');
const { extractAndSaveMemories, getMemoryEligibleText } = await import('../../../src/features/memory/service.js');
const { isPureQuestionTurn } = await import('../../../src/jobs/memory-extractor.js');

const reminderFact = {
  tool: 'manage_reminder',
  success: true,
  card: '✅ Recordatorios programados: llevar a mi amorcito en 10 minutos; decirle que la amo en 20 minutos; cita de Borona a las 4 de la tarde.',
  summary: '',
};

describe('durable memory extraction policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findOrCreateEntityFuzzy.mockResolvedValue({ id: 'entity-1', name: 'Borona' });
    saveMemory.mockResolvedValue({ id: 'memory-1' });
  });

  it('classifies pure recall/questions separately from learning turns', () => {
    expect(isPureQuestionTurn('¿Cómo me llamo?')).toBe(true);
    expect(isPureQuestionTurn('¿Qué recuerdas de mí?')).toBe(true);
    expect(isPureQuestionTurn('¿Cuál es mi comida favorita?\n¿Dónde vivo?')).toBe(true);
    expect(isPureQuestionTurn('Vivo en Barranquilla. ¿Lo recuerdas?')).toBe(false);
    expect(isPureQuestionTurn('Prefiero respuestas cortas')).toBe(false);
  });

  it('skips a turn whose clauses were fully consumed by operational tools', async () => {
    const userText = 'Recuérdame llevar a mi amorcito en 10 minutos. Dile que la amo en 20 minutos. Tenemos cita con Borona a las 4 de la tarde.';

    expect(getMemoryEligibleText(userText, [reminderFact])).toBe('');
    const saved = await extractAndSaveMemories({
      userId: 'user-1', userText, assistantReply: 'Todo quedó programado.', executionFacts: [reminderFact],
    });

    expect(saved).toEqual([]);
    expect(callMemoryExtraction).not.toHaveBeenCalled();
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
    expect(callMemoryExtraction).not.toHaveBeenCalled();
    expect(findOrCreateEntityFuzzy).not.toHaveBeenCalled();
  });

  it('rejects a mixed candidate whose evidence is not in the eligible user text', async () => {
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

  it('does not run background extraction after an explicit memory tool already saved the fact', async () => {
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
    expect(callMemoryExtraction).not.toHaveBeenCalled();
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
});
