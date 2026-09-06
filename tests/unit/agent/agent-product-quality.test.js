import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callConversationalPresentation,
  callManifestCoverageVerification,
  callOpenRouterChat,
  callResponseSynthesis,
} from '../../../src/agent/providers/client.js';
import { buildAgentCorePrompt } from '../../../src/agent/core/agent-core.js';
import { composeExecutionReply, createExecutionFact } from '../../../src/agent/core/execution-facts.js';
import { getToolDefinitions, parseToolArguments, validateToolCall } from '../../../src/agent/contracts/tool-contracts.js';
import { clearWorkingMemory, formatWorkingMemoryPrompt, getWorkingMemory, saveWorkingMemory } from '../../../src/agent/core/working-memory.js';
import { executeReminderTool } from '../../../src/agent/tools/reminders.js';
import { extractAndSaveMemories, retrieveRelevantMemories } from '../../../src/features/memory/service.js';

function coverageToolResponse(overrides = {}) {
  const args = {
    verdict: 'complete',
    confidence: 'high',
    missingQuote: '',
    feedback: '',
    assistantProposalKind: 'none',
    proposalConfidence: 'low',
    assistantClarificationKind: 'none',
    clarificationSubject: '',
    missingFields: [],
    clarificationConfidence: 'low',
    assistantResponseQuality: 'safe',
    responseConfidence: 'high',
    safeResponse: '',
    memoryDisposition: 'extract',
    ...overrides,
  };
  return new Response(JSON.stringify({
    provider: 'Groq',
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'coverage_1',
          type: 'function',
          function: {
            name: 'verify_manifest_coverage',
            arguments: JSON.stringify(args),
          },
        }],
      },
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Hermes product-quality agent contracts', () => {
  it('uses native provider tool calls instead of JSON Object Mode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'manage_task', arguments: '{"action":"list"}' },
          }],
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const tools = getToolDefinitions();
    const response = await callOpenRouterChat(
      [{ role: 'user', content: '¿Qué tareas tengo?' }],
      'openai/gpt-oss-120b',
      'sk-or-test',
      {
        tools,
        providers: ['groq'],
        reasoning: { effort: 'low', exclude: true },
        returnMessage: true,
        responseFormat: null,
      }
    );

    expect(response.tool_calls).toHaveLength(1);
    expect(response.tool_calls[0].function.name).toBe('manage_task');
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.tools).toHaveLength(7);
    expect(request.tool_choice).toBe('auto');
    expect(request).not.toHaveProperty('parallel_tool_calls');
    expect(request.provider.only).toEqual(['groq']);
    expect(request.reasoning).toEqual({ effort: 'low', exclude: true });
    expect(request).not.toHaveProperty('response_format');
  });

  it('omits non-portable parallel_tool_calls from OpenRouter tool requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      provider: 'Baseten',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'manage_task', arguments: '{"action":"list"}' },
          }],
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await callOpenRouterChat(
      [{ role: 'user', content: '¿Qué tareas tengo?' }],
      'z-ai/glm-5.3-flash',
      'sk-or-test',
      { tools: getToolDefinitions(), providers: ['baseten/fp8'], returnMessage: true },
    );

    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.tools).toHaveLength(7);
    expect(request.tool_choice).toBe('auto');
    expect(request).not.toHaveProperty('parallel_tool_calls');
  });

  it('exposes clear non-overlapping contracts and gates admin tools', () => {
    const normalTools = getToolDefinitions();
    const adminTools = getToolDefinitions({ isAdmin: true });
    const normalNames = normalTools.map((tool) => tool.function.name);
    const adminNames = adminTools.map((tool) => tool.function.name);

    expect(new Set(normalNames).size).toBe(normalNames.length);
    expect(normalNames).not.toContain('get_subscription_link');
    expect(normalNames).not.toContain('admin_metrics');
    expect(adminNames).toContain('admin_metrics');
    expect(normalTools.find((tool) => tool.function.name === 'get_unified_agenda').function.description)
      .toContain('cross-domain');
    expect(normalTools.find((tool) => tool.function.name === 'manage_google_calendar').function.description)
      .toContain('specifically');
  });

  it('rejects model-supplied identity and unsupported actions at the LLM boundary', () => {
    expect(validateToolCall({
      toolName: 'manage_task',
      params: { action: 'complete', target: 'la segunda', userId: 'foreign-user' },
    })).toMatchObject({ valid: false, errorCode: 'INVALID_PARAMETERS' });

    expect(validateToolCall({
      toolName: 'manage_task',
      params: { action: 'explode_database' },
    })).toMatchObject({ valid: false, errorCode: 'UNSUPPORTED_ACTION' });

    expect(validateToolCall({
      toolName: 'manage_task',
      params: { action: 'create', items: [{ title: 'Revisar', userId: 'foreign-user' }] },
    })).toMatchObject({ valid: false, errorCode: 'INVALID_PARAMETERS' });

    expect(validateToolCall({
      toolName: 'manage_task',
      params: { action: 'create', items: [{ title: 'Revisar' }], internalMode: true },
    })).toMatchObject({ valid: false, errorCode: 'INVALID_PARAMETERS' });

    expect(parseToolArguments('{broken')).toBeNull();
  });

  it('keeps internal entity IDs out of the model-facing contracts', () => {
    const tools = getToolDefinitions();
    const reminder = tools.find((tool) => tool.function.name === 'manage_reminder').function.parameters.properties;
    const task = tools.find((tool) => tool.function.name === 'manage_task').function.parameters.properties;
    const calendar = tools.find((tool) => tool.function.name === 'manage_google_calendar').function.parameters.properties;

    expect(reminder).not.toHaveProperty('reminderId');
    expect(task).not.toHaveProperty('taskId');
    expect(calendar).not.toHaveProperty('eventId');
  });

  it('models advance notice as an offset without replacing the primary reminder time', () => {
    const reminderTool = getToolDefinitions()
      .find((tool) => tool.function.name === 'manage_reminder').function;
    const itemSchema = reminderTool.parameters.properties.items.items;

    expect(reminderTool.description).toContain('both reminders');
    expect(itemSchema.properties.advanceMinutes).toMatchObject({
      type: 'integer',
      minimum: 1,
    });
    expect(itemSchema.properties.advanceMinutes.description).toContain('Keep targetTime as the primary');
    expect(itemSchema.properties.advanceMinutes.description).toContain('Never use this for');
    expect(itemSchema.properties.targetTime.description).toContain('PT10M');
    expect(itemSchema.properties.targetTime.description).toContain('Never put natural-language time text');
    expect(itemSchema.required).toContain('sourceTimeText');
    expect(itemSchema.properties.sourceTimeText.description).toContain('exact words');
  });

  it('preserves active entity identity privately without exposing IDs to the model', () => {
    const user = { id: 'user-1', phone_number: '+573000000001' };
    saveWorkingMemory(user, {
      source: 'task',
      entityType: 'task',
      activeEntity: 'Proyecto Hermes',
      activeEntityId: 'entity-private-id',
      items: [{ id: 'task-private-id', type: 'task', title: 'Revisar calidad', entityName: 'Proyecto Hermes' }],
    });

    expect(getWorkingMemory(user)).toMatchObject({
      activeEntity: 'Proyecto Hermes',
      activeEntityId: 'entity-private-id',
      entityType: 'task',
    });
    const prompt = formatWorkingMemoryPrompt(user);
    expect(prompt).toContain('Proyecto Hermes');
    expect(prompt).not.toContain('entity-private-id');
    expect(prompt).not.toContain('task-private-id');
    clearWorkingMemory(user);
  });

  it('reports partial success only from real execution facts', () => {
    const success = createExecutionFact({
      toolName: 'manage_task',
      params: { action: 'create' },
      result: { success: true, action: 'created_tasks_batch', confirmation: 'Tarea creada.' },
    });
    const failure = createExecutionFact({
      toolName: 'manage_reminder',
      params: { action: 'create' },
      result: { success: false, action: 'missing_time', errorCode: 'MISSING_REQUIRED_CONTEXT', error: 'Falta la hora.' },
    });

    const reply = composeExecutionReply([success, failure], 'es');
    expect(reply).toContain('Completé 1 acción');
    expect(reply).toContain('✅ Tarea creada.');
    expect(reply).toContain('⚠️ Falta la hora.');
  });

  it('keeps reminder cards intact, suppresses redundant framing, and ends warmly', () => {
    const fact = createExecutionFact({
      toolName: 'manage_reminder',
      params: { action: 'create' },
      result: {
        success: true,
        action: 'created_reminders_batch',
        rawSummary: 'Recordatorio creado.',
        formattedCard: '⏰ *Recordatorio creado*\n📌 Salir\n🕒 Hoy a las 6:03 PM',
      },
    });

    const reply = composeExecutionReply([fact], 'es', { framing: 'Perfecto, quedó programado.' });
    expect(reply).toBe('⏰ *Recordatorio creado*\n📌 Salir\n🕒 Hoy a las 6:03 PM\n\n¿Algo más en lo que pueda ayudarte?');
    expect(reply).not.toContain('Perfecto, quedó programado.');
    expect(fact.card).toContain('Hoy a las 6:03 PM');
  });

  it('keeps cards immutable while allowing a short conversational frame', () => {
    const fact = createExecutionFact({
      toolName: 'manage_reminder',
      params: { action: 'create' },
      result: {
        success: true,
        action: 'created_reminders_batch',
        formattedCard: '⏰ *Recordatorio creado*\n📌 Llamar a mamá\n🕒 Hoy a las 6:00 PM',
      },
    });

    const reply = composeExecutionReply([fact], 'es', {
      framing: { before: '', after: 'Cuando quieras, organizamos lo siguiente.' },
    });

    expect(reply).toBe(
      '⏰ *Recordatorio creado*\n📌 Llamar a mamá\n🕒 Hoy a las 6:00 PM\n\nCuando quieras, organizamos lo siguiente.',
    );
  });

  it('requests a compact post-tool frame without giving it authority over cards', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      provider: 'Groq',
      choices: [{
        finish_reason: 'stop',
        message: { content: '{"before":"Puedo ayudarte a organizar tu día, pero no enseñar programación.","after":""}' },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const framing = await callResponseSynthesis({
      userText: 'Recuérdame llamar a mamá y explícame cómo programar una API',
      facts: [{ outcome: 'success', action: 'created_reminders_batch', requiresClarification: false }],
      excludedClauses: [{ sourceQuote: 'explícame cómo programar una API', reason: 'prohibited' }],
      language: 'es',
    });

    expect(framing).toEqual({
      before: 'Puedo ayudarte a organizar tu día, pero no enseñar programación.',
      after: '',
    });
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.response_format).toEqual({ type: 'json_object' });
    expect(request).not.toHaveProperty('tools');
    expect(request.reasoning).toEqual({ effort: 'low', exclude: true });
    expect(request.messages[1].content).not.toContain('6:00 PM');
  });

  it('uses a semantic coverage guardrail instead of phrase matching', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(coverageToolResponse({
      verdict: 'incomplete',
      missingQuote: 'explícame cómo depurar Node',
      feedback: 'This is an unaccounted out-of-scope clause.',
    }));

    const verdict = await callManifestCoverageVerification({
      userText: 'Recuérdame caminar en 15 minutos y explícame cómo depurar Node',
      recentConversation: [
        { role: 'user', content: 'Tengo una diligencia el martes.' },
        { role: 'assistant', content: '¿A qué hora es?' },
      ],
      manifest: {
        operations: [{ kind: 'reminder_create', content: 'Caminar' }],
        excludedClauses: [],
      },
    });

    expect(verdict).toMatchObject({ verdict: 'incomplete', confidence: 'high' });
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request).not.toHaveProperty('response_format');
    expect(request.tools).toHaveLength(1);
    expect(request.tools[0].function.name).toBe('verify_manifest_coverage');
    expect(request.tool_choice).toBe('required');
    expect(request.reasoning).toEqual({ effort: 'medium', exclude: true });
    expect(request.max_tokens).toBe(1000);
    expect(request.messages[0].content).toContain('semantic coverage guardrail');
    expect(request.messages[0].content).toContain('active unfinished exchange');
    expect(request.messages[0].content).toContain('clean final answer in safeResponse');
    expect(JSON.parse(request.messages[1].content).recentConversation).toEqual([
      { role: 'user', content: 'Tengo una diligencia el martes.' },
      { role: 'assistant', content: '¿A qué hora es?' },
    ]);
  });

  it('formats verified prose visually through a model-guided presentation pass', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      provider: 'Groq',
      choices: [{
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            opening: '¡Claro! Puedo ayudarte a organizar tu día:',
            lines: [
              { emoji: '⏰', text: 'Crear y gestionar recordatorios' },
              { emoji: '✅', text: 'Organizar tareas y proyectos' },
              { emoji: '📅', text: 'Consultar tu agenda' },
              { emoji: '🧠', text: 'Guardar información en tu memoria personal' },
            ],
            closing: '¿Qué te gustaría hacer primero?',
          }),
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const formatted = await callConversationalPresentation({
      responseText: 'Puedo ayudarte con recordatorios, tareas, agenda y memoria. ¿Qué deseas hacer?',
      language: 'es',
    });

    expect(formatted).toBe(
      '¡Claro! Puedo ayudarte a organizar tu día:\n\n' +
      '⏰ Crear y gestionar recordatorios\n' +
      '✅ Organizar tareas y proyectos\n' +
      '📅 Consultar tu agenda\n' +
      '🧠 Guardar información en tu memoria personal\n\n' +
      '¿Qué te gustaría hacer primero?'
    );
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.response_format).toEqual({ type: 'json_object' });
    expect(request).not.toHaveProperty('tools');
    expect(request.messages[0].content).toContain('there is no fixed phrase or emoji mapping');
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain('ai-presentation');
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('ai-presentation');
  });

  it('asks the presentation model to retry a long response collapsed into one line', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    const collapsed = {
      opening: 'Puedo ayudarte con varias cosas:',
      lines: [{ emoji: '✨', text: 'Primera capacidad, segunda capacidad, tercera capacidad y cuarta capacidad sin separación visual.' }],
      closing: '¿Por dónde comenzamos?',
    };
    const improved = {
      opening: 'Puedo ayudarte con varias cosas:',
      lines: [
        { emoji: '1️⃣', text: 'Primera capacidad' },
        { emoji: '2️⃣', text: 'Segunda capacidad' },
        { emoji: '3️⃣', text: 'Tercera capacidad' },
        { emoji: '4️⃣', text: 'Cuarta capacidad' },
      ],
      closing: '¿Por dónde comenzamos?',
    };
    const apiResponse = (content) => new Response(JSON.stringify({
      provider: 'Groq',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(apiResponse(collapsed))
      .mockResolvedValueOnce(apiResponse(improved));

    const formatted = await callConversationalPresentation({
      responseText: 'Puedo ayudarte con una primera capacidad que tiene una explicación amplia, una segunda capacidad diferente, una tercera opción independiente y una cuarta posibilidad adicional. ¿Por dónde comenzamos?',
      language: 'es',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(formatted).toContain('1️⃣ Primera capacidad\n2️⃣ Segunda capacidad\n3️⃣ Tercera capacidad\n4️⃣ Cuarta capacidad');
    const retryRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryRequest.messages.at(-1).content).toContain('place each one in its own lines item');
  });

  it('retries a missing required coverage tool on the primary provider before fallback', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        provider: 'Groq',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(coverageToolResponse({ memoryDisposition: 'skip_operational' }));

    const verdict = await callManifestCoverageVerification({
      userText: 'Tengo una cita el martes.',
      manifest: { operations: [], excludedClauses: [] },
      assistantResponse: '¿A qué hora es la cita?',
    });

    expect(verdict).toMatchObject({
      verdict: 'complete',
      memoryDisposition: 'skip_operational',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const request = JSON.parse(call[1].body);
      expect(request.provider.only).toEqual(['groq']);
      expect(request.tool_choice).toBe('required');
    }
  });

  it('retries one transient provider finish error on the same primary route', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        provider: 'Groq',
        choices: [{ finish_reason: 'error', message: { role: 'assistant', content: null } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(coverageToolResponse());

    const verdict = await callManifestCoverageVerification({
      userText: '¿Qué compromisos tengo próximamente?',
      manifest: { operations: [{ kind: 'agenda_read', scope: 'upcoming' }], excludedClauses: [] },
    });

    expect(verdict).toMatchObject({ verdict: 'complete', confidence: 'high' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).provider.only).toEqual(['groq']);
  });

  it('asks for one missing appointment detail without a redundant permission round', () => {
    const prompt = buildAgentCorePrompt({
      nowStr: '2026-09-05T16:00:00-05:00',
      nowHumanStr: 'sábado, 5 de septiembre de 2026, 4:00 p. m.',
      timezone: 'America/Bogota',
    });

    expect(prompt).toContain('clarification_request con main_time');
    expect(prompt).toContain('El anticipo solo falta');
    expect(prompt).toContain('no escribas question, pidas permiso ni mezcles idiomas');
  });

  it('types an assistant-originated destructive offer so the router can stage it safely', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(coverageToolResponse({
      assistantProposalKind: 'reminder_cancel_elapsed',
      proposalConfidence: 'high',
      memoryDisposition: 'skip_operational',
    }));

    const verdict = await callManifestCoverageVerification({
      userText: 'Mmm, pero me salen recordatorios que ya pasaron',
      manifest: { operations: [], excludedClauses: [] },
      assistantResponse: '¿Quieres que elimine los recordatorios cuya hora ya pasó?',
    });

    expect(verdict).toMatchObject({
      verdict: 'complete',
      assistantProposal: { kind: 'reminder_cancel', scope: 'elapsed' },
      proposalConfidence: 'high',
    });
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(JSON.parse(request.messages[1].content)).toMatchObject({
      latestUserMessage: 'Mmm, pero me salen recordatorios que ya pasaron',
      assistantResponse: '¿Quieres que elimine los recordatorios cuya hora ya pasó?',
    });
  });

  it('returns one semantic clarification when assistant prose adds a redundant permission gate', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(coverageToolResponse({
      assistantClarificationKind: 'reminder_schedule',
      clarificationSubject: 'la cita',
      missingFields: ['main_time', 'advance_minutes'],
      clarificationConfidence: 'high',
    }));

    const verdict = await callManifestCoverageVerification({
      userText: 'Tengo una cita el martes.',
      manifest: { operations: [], excludedClauses: [] },
      assistantResponse: '¿Quieres que te cree un recordatorio?',
    });

    expect(verdict).toMatchObject({
      verdict: 'complete',
      assistantClarification: {
        kind: 'reminder_schedule',
        subject: 'la cita',
        missingFields: ['main_time', 'advance_minutes'],
      },
      clarificationConfidence: 'high',
      memoryDisposition: 'skip_operational',
    });
  });

  it('does not repeat a task inventory through model framing', () => {
    const fact = createExecutionFact({
      toolName: 'manage_task',
      params: { action: 'list', entityName: 'Trabajo' },
      result: {
        success: true,
        action: 'listed_tasks',
        formattedCard: '📋 *Pendientes de Trabajo*\n\n• Terminar el informe',
      },
    });

    const reply = composeExecutionReply([fact], 'es', {
      framing: 'Tienes una tarea pendiente: Terminar el informe.',
    });
    expect(reply).toBe('📋 *Pendientes de Trabajo*\n\n• Terminar el informe');
    expect(reply).not.toContain('Tienes una tarea pendiente');
  });

  it('shows a task completion once and closes warmly', () => {
    const fact = createExecutionFact({
      toolName: 'manage_task',
      params: { action: 'complete' },
      result: {
        success: true,
        action: 'completed_task',
        formattedCard: '✅ *Tarea completada*\n\n*Terminar el informe*',
      },
    });

    const reply = composeExecutionReply([fact], 'es', { framing: '✅ Tarea completada. ¿Algo más?' });
    expect(reply).toBe('✅ *Tarea completada*\n\n*Terminar el informe*\n\n¿Algo más en lo que pueda ayudarte?');
    expect(reply).not.toContain('✅ Tarea completada. ¿Algo más?');
  });

  it('marks partial tool execution as incomplete so model framing cannot overstate it', () => {
    const fact = createExecutionFact({
      toolName: 'manage_reminder',
      params: { action: 'create' },
      result: {
        success: true,
        partialSuccess: true,
        complete: false,
        action: 'partially_created_reminders',
        formattedCard: 'Dos recordatorios creados; uno pendiente de aclaración.',
      },
    });

    expect(fact).toMatchObject({ success: true, complete: false, outcome: 'partial_success' });
  });

  it('does not invent a default reminder time', async () => {
    const result = await executeReminderTool({
      action: 'create',
      params: { items: [{ content: 'Tomar agua' }] },
      user: {
        id: 'user-1',
        phone_number: '+573000000001',
        timezone: 'America/Bogota',
        subscription: { status: 'authorized', plan: 'pro' },
      },
      isPro: true,
    });

    expect(result).toMatchObject({
      success: false,
      errorCode: 'MISSING_REQUIRED_CONTEXT',
    });
  });

  it('uses a concise outcome-first scope and context policy instead of a rule catalogue', () => {
    const prompt = buildAgentCorePrompt({
      nowStr: '2026-09-04T13:00:00-05:00',
      nowHumanStr: '4 de septiembre de 2026, 1:00 p. m.',
      timezone: 'America/Bogota',
      memoryHints: '- [fact] Prefiere respuestas breves.',
      overview: null,
      workingMemoryText: '1. [Tarea] Revisar calidad',
      displayName: 'Lamparín',
      isAdmin: false,
      isPro: true,
    });

    expect(prompt).toContain('mensaje actual explícito > Working Memory');
    expect(prompt).toContain('Comprende primero el objetivo completo');
    expect(prompt).toContain('usa una sola llamada a execute_turn');
    expect(prompt).toContain('No enseñes, escribas, depures ni expliques programación o código');
    expect(prompt).toContain('petición completamente fuera de alcance');
    expect(prompt).toContain('conversar de manera natural sobre la vida cotidiana');
    expect(prompt).toContain('sourceQuote');
    expect(prompt).toContain('contextRef');
    expect(prompt).toContain('Nombre: Lamparín');
    expect(prompt).toContain('cards verificadas serán insertadas intactas');
    expect(prompt).toContain('ritmo visual adaptativo para WhatsApp');
    expect(prompt).toContain('sin forzar formato de card');
    expect(prompt).toContain('un emoji semántico por línea');
    expect(prompt).toContain('salto de línea estratégico');
    expect(prompt).toContain('un solo emoji pertinente');
    expect(prompt).toContain('feedback, no permiso para borrar datos');
    expect(prompt).toContain('reminder_cancel con scope=elapsed');
    expect(prompt.length).toBeLessThan(6000);
    expect(prompt).not.toContain('PATRONES CANÓNICOS');
    expect(prompt).not.toContain('## REGLAS CRÍTICAS');
    expect(prompt).not.toContain('SALIDA JSON ESTRICTA');
  });

  it('does not use attachment OCR text as a long-term memory retrieval query', async () => {
    const memories = await retrieveRelevantMemories({
      userId: 'user-1',
      queryText: `¿Qué lees?\n<untrusted_attachment_content>${'document text '.repeat(100)}</untrusted_attachment_content>`,
    });
    expect(memories).toEqual([]);
  });

  it('does not extract persistent memories from a captionless attachment', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const saved = await extractAndSaveMemories({
      userId: 'user-1',
      userText: '<untrusted_attachment_content>El texto visible menciona proyectos y personas.</untrusted_attachment_content>',
      assistantReply: 'Veo una laptop plateada abierta sobre una mesa.',
    });

    expect(saved).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
