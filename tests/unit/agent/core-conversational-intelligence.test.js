import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/agent/tools/index.js', () => ({
  executeTool: vi.fn(),
}));
vi.mock('../../../src/agent/providers/client.js', () => ({
  callChatCompletion: vi.fn(),
  callResponseSynthesis: vi.fn().mockResolvedValue(null),
  callPendingTransitionVerification: vi.fn(),
}));
vi.mock('../../../src/features/memory/service.js', () => ({
  retrieveRelevantMemories: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  getDailyOverview: vi.fn().mockResolvedValue(null),
  getUserSubscription: vi.fn().mockResolvedValue({ status: 'authorized', plan: 'pro' }),
  getUserIntegration: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn().mockReturnValue(true),
  createPendingSubscription: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../src/integrations/mercado-pago/client.js', () => ({
  getOrCreateCanonicalPlan: vi.fn(),
}));
vi.mock('../../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(() => 'https://example.test/google'),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));

import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { callChatCompletion } from '../../../src/agent/providers/client.js';
import { clearWorkingMemory, getWorkingMemory } from '../../../src/agent/core/working-memory.js';
import { getActiveAgentRun } from '../../../src/agent/core/agent-run.js';
import { executeTurnIntent } from '../../../src/agent/orchestration/intent-executor.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';

const user = {
  id: 'user-core-intelligence-test',
  phone_number: '573046154163',
  timezone: 'America/Bogota',
  locale: 'es-CO',
  display_name: 'Juan',
};

function modelResponse(payload) {
  return { role: 'assistant', content: JSON.stringify(payload), tool_calls: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearWorkingMemory(user);
});

describe('Core Conversational Intelligence Upgrade', () => {
  describe('1. Multi-Draft Reminder Batch Continuation', () => {
    it('stages all N drafts in a single AgentRun and creates ALL of them upon continuation', async () => {
      const context = {
        user,
        isPro: true,
        language: 'es',
        timezone: 'America/Bogota',
        referenceTime: new Date('2026-09-12T12:00:00.000Z'),
        correlationId: 'test-multi-draft-t1',
      };

      // Turn 1: 3 reminder drafts lacking the date
      const intent = {
        actions: [
          {
            domain: 'reminder',
            action: 'create',
            content: 'Hacer ejercicio',
            schedule: { kind: 'local_time', hour: 9, minute: 0, clockMode: 'explicit_12h_am' },
            missingFields: ['date'],
          },
          {
            domain: 'reminder',
            action: 'create',
            content: 'Llamar al cliente',
            schedule: { kind: 'local_time', hour: 10, minute: 0, clockMode: 'explicit_12h_am' },
            missingFields: ['date'],
          },
          {
            domain: 'reminder',
            action: 'create',
            content: 'Enviar reporte',
            schedule: { kind: 'local_time', hour: 11, minute: 0, clockMode: 'explicit_12h_am' },
            missingFields: ['date'],
          },
        ],
        clarification: {
          domain: 'clarification',
          action: 'request',
          question: '¿Para qué día programo los recordatorios?',
        },
      };

      const execution = await executeTurnIntent(intent, context);
      expect(execution.records).toHaveLength(1);
      expect(execution.records[0].result.requiresClarification).toBe(true);

      const stagedRun = await getActiveAgentRun(user);
      expect(stagedRun).not.toBeNull();
      expect(stagedRun.status).toBe('waiting_for_input');
      expect(stagedRun.preparedActions).toHaveLength(3);
      expect(stagedRun.preparedActions[0].payload.content).toBe('Hacer ejercicio');
      expect(stagedRun.preparedActions[1].payload.content).toBe('Llamar al cliente');
      expect(stagedRun.preparedActions[2].payload.content).toBe('Enviar reporte');

      // Turn 2: Continuation with "mañana"
      callChatCompletion.mockResolvedValueOnce(modelResponse({
        relation: 'resume',
        suppliedFields: {
          schedule: {
            kind: 'relative_day_time',
            dayOffset: 1,
          },
        },
        reply: 'Listo, programé los 3 recordatorios para mañana.',
      }));

      // executeTool will be called 3 times (once per reminder)
      executeTool
        .mockResolvedValueOnce({
          success: true,
          action: 'created_reminder',
          data: { id: 'rem-1', content: 'Hacer ejercicio', targetTime: '2026-09-13T14:00:00.000Z' },
          rawSummary: 'Recordatorio programado para mañana a las 9:00 AM.',
        })
        .mockResolvedValueOnce({
          success: true,
          action: 'created_reminder',
          data: { id: 'rem-2', content: 'Llamar al cliente', targetTime: '2026-09-13T15:00:00.000Z' },
          rawSummary: 'Recordatorio programado para mañana a las 10:00 AM.',
        })
        .mockResolvedValueOnce({
          success: true,
          action: 'created_reminder',
          data: { id: 'rem-3', content: 'Enviar reporte', targetTime: '2026-09-13T16:00:00.000Z' },
          rawSummary: 'Recordatorio programado para mañana a las 11:00 AM.',
        });

      const turn2Result = await routeMessage('mañana', user, [], {
        referenceTime: new Date('2026-09-12T12:00:00.000Z'),
      });

      expect(turn2Result.intent).toBe('reminder');
      expect(turn2Result.plan.type).toBe('continuation_decision');
      expect(executeTool).toHaveBeenCalledTimes(3);

      // Verify each reminder was executed with its distinct hour preserved
      expect(executeTool).toHaveBeenNthCalledWith(1, expect.objectContaining({
        toolName: TOOL_NAMES.MANAGE_REMINDER,
        params: expect.objectContaining({
          items: [expect.objectContaining({ content: 'Hacer ejercicio' })],
        }),
      }));
      expect(executeTool).toHaveBeenNthCalledWith(2, expect.objectContaining({
        toolName: TOOL_NAMES.MANAGE_REMINDER,
        params: expect.objectContaining({
          items: [expect.objectContaining({ content: 'Llamar al cliente' })],
        }),
      }));
      expect(executeTool).toHaveBeenNthCalledWith(3, expect.objectContaining({
        toolName: TOOL_NAMES.MANAGE_REMINDER,
        params: expect.objectContaining({
          items: [expect.objectContaining({ content: 'Enviar reporte' })],
        }),
      }));

      // Invariant: Run is marked completed
      const activeRunAfterResume = await getActiveAgentRun(user);
      expect(activeRunAfterResume).toBeNull();

      // Invariant: Working Memory has all 3 reminders
      const wm = getWorkingMemory(user);
      expect(wm?.items).toHaveLength(3);
    });
  });

  describe('2. Actionable Proposal Staging (TIME_IN_PAST)', () => {
    it('stages a proposal_approval run when tool rejects past time with alternative, and executes on "si"', async () => {
      const context = {
        user,
        isPro: true,
        language: 'es',
        timezone: 'America/Bogota',
        referenceTime: new Date('2026-09-12T15:00:00.000Z'), // 10:00 AM Bogota
        correlationId: 'test-proposal-t1',
      };

      // Turn 1: executeTool returns TIME_IN_PAST with proposedReminder
      executeTool.mockResolvedValueOnce({
        success: false,
        complete: false,
        action: 'reminder_clarification_required',
        errorCode: 'TIME_IN_PAST',
        error: 'la hora indicada ya pasó.',
        rawSummary: '⚠️ *Hora en el pasado*\n\n¿Quieres que lo programe mañana a las 8:00 AM?',
        requiresClarification: true,
        data: {
          pendingClarifications: [{
            type: 'reminder',
            content: 'Tomar medicina',
            code: 'TIME_IN_PAST',
            question: '¿Quieres que lo programe mañana a las 8:00 AM?',
            proposedReminder: {
              targetTime: '2026-09-13T13:00:00.000Z',
            },
          }],
        },
      });

      const intent = {
        actions: [{
          domain: 'reminder',
          action: 'create',
          content: 'Tomar medicina',
          schedule: { kind: 'local_time', hour: 8, minute: 0, clockMode: 'explicit_12h_am' },
        }],
      };

      await executeTurnIntent(intent, context);

      // Verify proposal_approval run was staged in waiting_for_approval
      const activeRun = await getActiveAgentRun(user);
      expect(activeRun).not.toBeNull();
      expect(activeRun.status).toBe('waiting_for_approval');
      expect(activeRun.kind).toBe('proposal_approval');
      expect(activeRun.waiting_for.question).toBe('¿Quieres que lo programe mañana a las 8:00 AM?');
      expect(activeRun.preparedActions).toHaveLength(1);
      expect(activeRun.preparedActions[0].payload.items[0]).toMatchObject({
        content: 'Tomar medicina',
        targetTime: '2026-09-13T13:00:00.000Z',
      });

      // Turn 2: User confirms with "dale" or "si"
      callChatCompletion.mockResolvedValueOnce(modelResponse({
        relation: 'approval',
        decision: 'approve_all',
        reply: 'Listo, programé el recordatorio para mañana a las 8:00 AM.',
      }));

      executeTool.mockResolvedValueOnce({
        success: true,
        action: 'created_reminder',
        data: {
          id: 'rem-medicine-1',
          content: 'Tomar medicina',
          targetTime: '2026-09-13T13:00:00.000Z',
        },
        rawSummary: 'Recordatorio programado para mañana a las 8:00 AM.',
      });

      const turn2Result = await routeMessage('dale', user, [], {
        referenceTime: new Date('2026-09-12T15:01:00.000Z'),
      });

      expect(turn2Result.intent).toBe('reminder');
      expect(turn2Result.plan.type).toBe('approval_decision');
      expect(turn2Result.plan.decision).toBe('approve_all');
      expect(executeTool).toHaveBeenCalledTimes(2);

      // Verify the reminder was created with the proposed targetTime
      expect(executeTool).toHaveBeenLastCalledWith(expect.objectContaining({
        toolName: TOOL_NAMES.MANAGE_REMINDER,
        params: expect.objectContaining({
          action: 'create',
          items: [expect.objectContaining({
            content: 'Tomar medicina',
            targetTime: '2026-09-13T13:00:00.000Z',
          })],
        }),
        clarificationResolution: true,
      }));

      // Invariant: Run is now completed
      const activeRunAfterApproval = await getActiveAgentRun(user);
      expect(activeRunAfterApproval).toBeNull();
    });
  });

  describe('3. Deictic Grounding & Ambiguous Target Working Memory', () => {
    it('populates Working Memory with candidates when reminder-update encounters ambiguous targets', async () => {
      const candidates = [
        { id: 'rem-1', content: 'Llamar al banco por tarjeta', send_at: '2026-09-14T15:00:00.000Z' },
        { id: 'rem-2', content: 'Llamar al banco por préstamo', send_at: '2026-09-15T15:00:00.000Z' },
      ];

      executeTool.mockResolvedValueOnce({
        success: false,
        action: 'reminder_target_ambiguous',
        errorCode: 'AMBIGUOUS_TARGET',
        error: 'Encontré varios recordatorios que coinciden. ¿Cuál deseas actualizar?\n1. "Llamar al banco por tarjeta"\n2. "Llamar al banco por préstamo"',
        formattedCard: 'Encontré varios recordatorios que coinciden. ¿Cuál deseas actualizar?\n1. "Llamar al banco por tarjeta"\n2. "Llamar al banco por préstamo"',
        requiresClarification: true,
        data: { reminders: candidates },
      });

      const context = {
        user,
        isPro: true,
        language: 'es',
        timezone: 'America/Bogota',
      };

      const intent = {
        actions: [{
          domain: 'reminder',
          action: 'update',
          target: 'Llamar al banco',
          schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 10, minute: 0, clockMode: 'explicit_12h_am' },
        }],
      };

      await executeTurnIntent(intent, context);

      const wm = getWorkingMemory(user);
      expect(wm).not.toBeNull();
      expect(wm.items).toHaveLength(2);
      expect(wm.items[0].internalId).toBe('rem-1');
      expect(wm.items[0].position).toBe(1);
      expect(wm.items[1].internalId).toBe('rem-2');
      expect(wm.items[1].position).toBe(2);
    });

    it('populates Working Memory with candidates when task-complete encounters ambiguous targets', async () => {
      const candidates = [
        { id: 'task-1', title: 'Comprar café en grano' },
        { id: 'task-2', title: 'Comprar café molido' },
      ];

      executeTool.mockResolvedValueOnce({
        success: false,
        action: 'task_target_ambiguous',
        errorCode: 'AMBIGUOUS_TARGET',
        error: 'Encontré varias tareas que coinciden. ¿Cuál deseas completar?\n1. "Comprar café en grano"\n2. "Comprar café molido"',
        formattedCard: 'Encontré varias tareas que coinciden. ¿Cuál deseas completar?\n1. "Comprar café en grano"\n2. "Comprar café molido"',
        requiresClarification: true,
        data: { tasks: candidates },
      });

      const context = {
        user,
        isPro: true,
        language: 'es',
        timezone: 'America/Bogota',
      };

      const intent = {
        actions: [{
          domain: 'task',
          action: 'complete',
          target: 'Comprar café',
        }],
      };

      await executeTurnIntent(intent, context);

      const wm = getWorkingMemory(user);
      expect(wm).not.toBeNull();
      expect(wm.items).toHaveLength(2);
      expect(wm.items[0].internalId).toBe('task-1');
      expect(wm.items[0].position).toBe(1);
      expect(wm.items[1].internalId).toBe('task-2');
      expect(wm.items[1].position).toBe(2);
    });
  });
});

