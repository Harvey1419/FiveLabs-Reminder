import { describe, expect, it } from 'vitest';
import { compileTurnIntentV2, isTurnIntentV2 } from '../../../src/agent/orchestration/turn-intent-v2.js';

describe('TurnIntent v2', () => {
  it('compiles a simple reminder without making the model author protocol fields', () => {
    const intent = {
      actions: [{
        domain: 'reminder', action: 'create', content: 'Comprar leche',
        schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 8, minute: 0, clockMode: 'ambiguous_12h' },
      }],
    };
    const result = compileTurnIntentV2(intent, { userMessage: 'Recuérdame comprar leche mañana a las 8' });
    expect(result.valid).toBe(true);
    expect(result.manifest.operations).toEqual([expect.objectContaining({
      sequence: 1, kind: 'reminder_create', sourceQuote: 'Recuérdame comprar leche mañana a las 8', content: 'Comprar leche',
    })]);
    expect(intent.actions[0]).not.toHaveProperty('sequence');
    expect(intent.actions[0]).not.toHaveProperty('sourceQuote');
    expect(intent.actions[0]).not.toHaveProperty('contextRef');
  });

  it('maps human targets directly and leaves ID resolution to Node', () => {
    const result = compileTurnIntentV2({ actions: [{ domain: 'task', action: 'complete', target: 'la segunda' }] }, { userMessage: 'La segunda ya la hice' });
    expect(result).toMatchObject({
      valid: true,
      manifest: { operations: [{ sequence: 1, kind: 'task_complete', sourceQuote: 'La segunda ya la hice', targetName: 'la segunda' }], excludedClauses: [] },
    });
  });

  it('creates pending-state protocol internally instead of exposing it to the model', () => {
    const result = compileTurnIntentV2({ actions: [{ domain: 'pending', action: 'execute', target: '1' }] }, { userMessage: 'Sí, hazlo' });
    expect(result.valid).toBe(true);
    expect(result.manifest.operations[0]).toMatchObject({ kind: 'execute_pending', contextRef: { source: 'pending_state', position: 1 } });
  });

  it('keeps multi-action order while generating sequence numbers internally', () => {
    const result = compileTurnIntentV2({
      actions: [
        { domain: 'task', action: 'create', title: 'Comprar pan' },
        { domain: 'reminder', action: 'create', content: 'Llamar a mamá', schedule: { kind: 'relative_offset', offsetMinutes: 30 } },
      ],
    }, { userMessage: 'Anota comprar pan y recuérdame llamar a mamá en 30 minutos' });
    expect(result.valid).toBe(true);
    expect(result.manifest.operations.map(({ sequence, kind }) => ({ sequence, kind }))).toEqual([
      { sequence: 1, kind: 'task_create' }, { sequence: 2, kind: 'reminder_create' },
    ]);
  });

  it('normalizes semantic memory read/recall verbs instead of leaking protocol errors', () => {
    const read = compileTurnIntentV2({
      actions: [{ domain: 'memory', action: 'read', query: 'mi nombre' }],
    }, { userMessage: '¿Cómo me llamo?' });
    expect(read.valid).toBe(true);
    expect(read.manifest.operations[0]).toMatchObject({ kind: 'memory_search', query: 'mi nombre' });

    const recall = compileTurnIntentV2({
      actions: [{ domain: 'memory', action: 'recall', target: 'mi comida favorita' }],
    }, { userMessage: '¿Cuál es mi comida favorita?' });
    expect(recall.valid).toBe(true);
    expect(recall.manifest.operations[0]).toMatchObject({ kind: 'memory_search', query: 'mi comida favorita' });
    expect(recall.manifest.operations[0]).not.toHaveProperty('targetName');
  });

  it('degrades subjectless memory reads to a list instead of failing', () => {
    const result = compileTurnIntentV2({ actions: [{ domain: 'memory', action: 'get' }] }, { userMessage: '¿Qué recuerdas de mí?' });
    expect(result.valid).toBe(true);
    expect(result.manifest.operations[0].kind).toBe('memory_list');
  });

  it('preserves mixed-turn exclusions in the legacy manifest', () => {
    const result = compileTurnIntentV2({
      actions: [{ domain: 'task', action: 'create', title: 'Comprar pan' }],
      excluded: [{ quote: 'y explícame cómo programar Node', reason: 'prohibited' }],
    }, { userMessage: 'Anota comprar pan y explícame cómo programar Node' });
    expect(result.valid).toBe(true);
    expect(result.manifest.excludedClauses).toEqual([{ sourceQuote: 'y explícame cómo programar Node', reason: 'prohibited' }]);
  });

  it('rejects truly unsupported domain/action pairs deterministically', () => {
    const result = compileTurnIntentV2({ actions: [{ domain: 'reminder', action: 'explode' }] }, { userMessage: 'haz algo' });
    expect(result).toMatchObject({ valid: false, errorCode: 'UNSUPPORTED_ACTION' });
  });

  it('detects v2 payloads without confusing legacy manifests', () => {
    expect(isTurnIntentV2({ actions: [] })).toBe(true);
    expect(isTurnIntentV2({ operations: [] })).toBe(false);
  });
});
