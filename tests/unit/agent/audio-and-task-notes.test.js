import { describe, expect, it, vi } from 'vitest';
import { buildAgentCorePrompt } from '../../../src/agent/core/agent-core.js';
import * as db from '../../../src/infrastructure/database/index.js';
import * as reference from '../../../src/agent/tools/task-reference.js';
import { executeTaskUpdate } from '../../../src/agent/tools/task-update.js';

describe('Audio interpretation and task notes enhancement', () => {
  it('includes audio modality and spoken self-correction guidelines in system prompt', () => {
    const prompt = buildAgentCorePrompt({
      nowStr: '2026-09-14T10:00:00-05:00',
      nowHumanStr: 'lunes, 14 de septiembre de 2026, 10:00 a. m.',
      timezone: 'America/Bogota',
      displayName: 'Harvey',
      inputModality: 'audio',
    });

    expect(prompt).toContain('🎙️ Audio');
    expect(prompt).toContain('Auto-correcciones / Voz');
    expect(prompt).toContain('ÚLTIMA instrucción prevalece');
    process.stdout.write(`Compaction audio fixture: ${prompt.length} characters\n`);
    expect(prompt.length).toBeLessThan(6000);
  });

  it('correctly maps task description/notes when updating an existing task', async () => {
    const updateTaskSpy = vi.spyOn(db, 'updateTask').mockResolvedValue({
      id: 'task-uuid-123',
      title: 'Llamar al contador',
      description: 'Pedirle el balance y RUT actualizado',
      status: 'pending',
    });

    vi.spyOn(reference, 'resolveTaskTarget').mockResolvedValue({
      status: 'RESOLVED',
      taskId: 'task-uuid-123',
    });

    const result = await executeTaskUpdate({
      params: {
        target: 'Llamar al contador',
        updates: {
          description: 'Pedirle el balance y RUT actualizado',
        },
      },
      user: { id: 'user-uuid-1', phone_number: '+573001234567' },
      language: 'es',
    });

    expect(result.success).toBe(true);
    expect(updateTaskSpy).toHaveBeenCalledWith(
      'task-uuid-123',
      expect.objectContaining({
        description: 'Pedirle el balance y RUT actualizado',
      }),
      'user-uuid-1'
    );

    updateTaskSpy.mockRestore();
  });
});
