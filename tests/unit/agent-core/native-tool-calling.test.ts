import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ProductivityTurnRunner, nativeToolSchema } from '@templelabs/agent-core';
import { MockAIProvider } from '@templelabs/ai';
import { createTaskTools, createProjectTools, ToolRegistry, type ProjectDomainPort, type TaskDomainPort } from '@templelabs/tools';
import { jsonObjectSchema, type ProjectResult, type TaskResult, type AIResponse, type ToolCall } from '@templelabs/contracts';
import { context, response, taskId } from './productivity-fixtures.js';

const projectId = '22222222-2222-4222-8222-222222222222';
const presentation = { canonicalCard: null, questions: [], cta: null };
const taskData: TaskResult = { operation: 'read', complete: true, coverage: 'bounded_list', issues: [], presentation, flow: null,
  records: [{ id: taskId, title: 'Enviar propuesta', entityId: projectId, entityName: 'Atlas', priority: 'high',
    description: null, dueDateIso: null, status: 'pending' }] };
const projectData: ProjectResult = { operation: 'read', complete: true, issues: [], presentation,
  projects: [{ id: projectId, name: 'Atlas', description: null, status: 'active' }] };
const say = (content: string): AIResponse => ({ ...response(), message: { role: 'assistant', content, toolCalls: [] } });
function fixture(script: AIResponse[], authorize = false) {
  const taskExecute = vi.fn<TaskDomainPort['execute']>(async (request, ctx, operationId) => {
    const data: TaskResult = { ...taskData, operation: request.operation, coverage: request.operation === 'read' ? 'bounded_list' : 'operation' };
    return { status: 'success', data, observation: JSON.stringify(data), receipt: { userId: ctx.userId, operationId, toolName: `task_${request.operation}`, resourceIds: [taskId] } };
  });
  const projectExecute = vi.fn<ProjectDomainPort['execute']>(async (_request, ctx, operationId) => ({ status: 'success', data: projectData,
    observation: JSON.stringify(projectData), receipt: { userId: ctx.userId, operationId, toolName: 'project_read', resourceIds: [projectId] } }));
  const provider = new MockAIProvider(script.map(response => ({ response })));
  const registry = new ToolRegistry([...createTaskTools({ execute: taskExecute }), ...createProjectTools({ execute: projectExecute })]);
  const runner = new ProductivityTurnRunner(provider, registry, { nativeToolCalling: true, continuation: 'observation_driven',
    compactObservations: true, maxModelSteps: 5, maxInputTokens: 16000, maxTotalTokens: 60000, authorizeWrite: async () => authorize });
  const journal = { beforeDispatch: vi.fn(async () => {}), afterOutcome: vi.fn(async () => {}) };
  const ctx = { ...context, capabilities: new Set(['projects.read', 'tasks.read', 'tasks.create', 'tasks.update']) };
  return { runner, provider, registry, taskExecute, projectExecute, journal, ctx };
}

describe('native tool loop', () => {
  it('keeps all authorized tools available and returns to the model between partial reads', async () => {
    const f = fixture([response([{ id: 'projects', name: 'project_read', arguments: {} }]),
      response([{ id: 'tasks', name: 'task_read', arguments: { status: 'pending' } }]), say('Revisé proyectos y tareas.')]);
    const result = await f.runner.run('Consulta mis proyectos y tareas pendientes.', f.ctx);
    expect(f.provider.requests).toHaveLength(3);
    expect(f.taskExecute).toHaveBeenCalledOnce(); expect(f.projectExecute).toHaveBeenCalledOnce();
    expect(result.uiPayload.notices).toEqual([]);
    expect(result.uiPayload.items.map(item => item.toolName)).toEqual(['project_read', 'task_read']);
    for (const request of f.provider.requests) {
      expect(request.tools.map(t => t.name)).toEqual(['task_create', 'task_read', 'task_update', 'project_read']);
      expect(JSON.stringify(request.tools)).not.toMatch(/tools_select|conversation_decide|decisionItem|turnDisposition/);
    }
    expect(JSON.stringify(f.provider.requests[1]!.messages)).toContain('Atlas');
    expect(JSON.stringify(f.provider.requests[2]!.messages)).toContain('entityName');
  });

  it('still rejects invalid UUIDs before dispatch, even without a model-facing UUID regex', async () => {
    const f = fixture([response([{ id: 'invalid', name: 'task_update', arguments: { taskId: 'not-an-id', title: 'Cambio' } }]), say('Necesito identificar la tarea.')], true);
    const result = await f.runner.run('Cambia el título de una tarea.', f.ctx, undefined, f.journal);
    expect(f.taskExecute).not.toHaveBeenCalled();
    expect(result.uiPayload.items[0]).toMatchObject({ status: 'clarification_required', code: 'REFERENCE_REQUIRED' });
    expect(await f.registry.execute('task_update', { taskId: 'not-an-id', title: 'Cambio' }, f.ctx, 'invalid-input'))
      .toMatchObject({ status: 'validation_failed', code: 'INVALID_ARGUMENTS' });
    expect(f.taskExecute).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps host write authorization and journal requirements, authorized=%s', async authorized => {
    const f = fixture([response([{ id: 'write', name: 'task_create', arguments: { title: 'Enviar propuesta' } }]), say('Revisé el resultado.')], authorized);
    const result = await f.runner.run('Crea la tarea Enviar propuesta.', f.ctx, undefined, f.journal);
    expect(f.taskExecute).toHaveBeenCalledTimes(authorized ? 1 : 0);
    expect(result.uiPayload.items[0]?.status).toBe(authorized ? 'success' : 'approval_required');
    if (authorized) { expect(f.journal.beforeDispatch).toHaveBeenCalledOnce(); expect(f.journal.afterOutcome).toHaveBeenCalledOnce(); }
  });

  it('never exposes tools outside the current capability set', async () => {
    const f = fixture([say('¿Qué tarea querés consultar?')]);
    await f.runner.run('Hola.', { ...f.ctx, capabilities: new Set(['tasks.read']) });
    expect(f.provider.requests[0]!.tools.map(t => t.name)).toEqual(['task_read']);
  });

  it('still requires a durable journal before a permitted write', async () => {
    const f = fixture([response([{ id: 'write', name: 'task_create', arguments: { title: 'Enviar propuesta' } }]), say('No pude confirmar la operación.')], true);
    const result = await f.runner.run('Crea la tarea Enviar propuesta.', f.ctx);
    expect(f.taskExecute).not.toHaveBeenCalled();
    expect(result.uiPayload.items[0]).toMatchObject({ code: 'DURABLE_JOURNAL_REQUIRED' });
  });

  it('resolves a saved decision checkpoint when opting into the native loop', async () => {
    const f = fixture([response([
      { id: 'resolve', name: 'conversation_decide', arguments: { ready: [{ key: 'task', tool: 'task_create' }], resolution: { pendingId: 'pending-task', key: 'task' } } },
      { id: 'create', name: 'task_create', arguments: { title: 'Enviar propuesta', decisionItem: 'task' } },
    ])], true);
    const previous = { userId: f.ctx.userId, history: [{ role: 'user' as const, content: 'Crea la tarea Enviar propuesta.' },
      { role: 'assistant' as const, content: '¿Con qué prioridad?', toolCalls: [] }], tasks: [], reminders: [], events: [], handledRequestIds: ['older-request'],
      pending: { id: 'pending-task', userId: f.ctx.userId, sourceRequestId: 'older-request',
        sourceContext: { referenceTimeIso: f.ctx.referenceTimeIso, timezone: f.ctx.timezone },
        tool: 'task_create' as const, missing: 'details' as const, knownArguments: { title: 'Enviar propuesta' } } };
    const result = await f.runner.run('Prioridad alta.', f.ctx, previous, f.journal);
    expect(result.conversation.pending).toBeUndefined();
    expect(f.taskExecute).toHaveBeenCalledOnce();
    expect(result.uiPayload.notices).toEqual([]);
  });

  it('does not repeat a successful write when the model proposes it twice', async () => {
    const call: ToolCall = { id: 'first', name: 'task_create', arguments: { title: 'Enviar propuesta' } };
    const f = fixture([response([call]), response([{ ...call, id: 'again' }]), say('Listo.')], true);
    await f.runner.run('Crea la tarea Enviar propuesta.', f.ctx, undefined, f.journal);
    expect(f.taskExecute).toHaveBeenCalledOnce();
  });
});

describe('native model schema projection', () => {
  it('preserves field names, enums, nullability and numeric bounds without changing the backend validator', () => {
    const input = z.strictObject({ pattern: z.string().regex(/^ok$/), minLength: z.uuid(),
      priority: z.enum(['low', 'high']), hour: z.number().min(0).max(23), note: z.string().nullable().optional() });
    const raw = z.toJSONSchema(input, { io: 'input' });
    const projected = nativeToolSchema(jsonObjectSchema.parse(raw));
    expect(projected).toMatchObject({ additionalProperties: false, required: ['pattern', 'minLength', 'priority', 'hour'], properties: {
      pattern: { type: 'string' }, minLength: { type: 'string', format: 'uuid' }, priority: { enum: ['low', 'high'] },
      hour: { minimum: 0, maximum: 23 }, note: { type: ['string', 'null'] },
    } });
    expect(input.safeParse({ pattern: 'bad', minLength: taskId, priority: 'high', hour: 12 }).success).toBe(false);
    expect(JSON.stringify(raw)).toContain('pattern');
    expect((projected.properties as Record<string, { pattern?: string }>).pattern!.pattern).toBeUndefined();
  });
});
