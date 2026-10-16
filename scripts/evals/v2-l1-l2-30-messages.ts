import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { OpenRouterProvider, MockAIProvider, estimateBoundedInput, type AIResponse } from '@templelabs/ai';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import {
  aiTranscriptSchema, jsonObjectSchema, type ProductivityConversation,
  type ReminderRecord, type TaskRecord, type TurnContext,
} from '@templelabs/contracts';
import {
  createReminderTools, createTaskTools, createAgendaTools, ToolRegistry,
  type ReminderDomainPort, type TaskDomainPort,
} from '@templelabs/tools';
import { DurableProductivityAssistant } from '../../src/adapters/agent-core/durable-productivity-assistant.js';
import { productivityBudget, productivityDecisionPolicy } from '../../src/adapters/agent-core/productivity-budget.js';
import { recentToolScope } from '../../src/adapters/agent-core/recent-tool-scope.js';
import { withTurnLease, type InboundTurnLease } from '../../src/agent/core/turn-lease.js';
import { createConfiguredAIProvider } from '../../src/adapters/agent-core/configured-ai-provider.js';
import { createSyntheticReminders, SYNTHETIC_USER } from './v2-fluent-conversation.js';

const wire = new OpenRouterProvider({
  apiKey: 'offline',
  routes: [{ id: 'primary', model: 'openai/gpt-oss-120b', providers: ['groq'], timeoutMs: 6000 }],
  estimateInputTokens: estimateBoundedInput,
});

const anchor = '2026-10-15T23:52:00Z'; // 6:52 PM America/Bogota

function createSyntheticTasks() {
  const tasks = new Map<string, TaskRecord>();
  let sequence = 0;
  const execute: TaskDomainPort['execute'] = async (request, context, operationId) => {
    let selected: TaskRecord[] = [];
    if (request.operation === 'create') {
      const record: TaskRecord = {
        id: `33333333-3333-4333-8333-${String(++sequence).padStart(12, '0')}`,
        title: request.input.title,
        description: null,
        priority: null,
        status: 'pending',
        dueDateIso: request.input.dueDateIso ?? null,
        entityId: null,
        entityName: request.input.entityName ?? null,
      };
      tasks.set(record.id, record);
      selected = [record];
    } else if (request.operation === 'read') {
      selected = [...tasks.values()];
    }
    const data = {
      operation: request.operation,
      records: structuredClone(selected),
      complete: true,
      coverage: request.operation === 'read' ? ('bounded_list' as const) : ('operation' as const),
      issues: [],
      presentation: { canonicalCard: null, questions: [], cta: null },
      flow: null,
    };
    const receipt = { userId: context.userId, operationId, toolName: `task_${request.operation}`, resourceIds: selected.map(t => t.id) };
    return { status: 'success' as const, data, observation: JSON.stringify(data), receipt };
  };
  return { execute };
}

const answer = (calls: AIResponse['message']['toolCalls'] = [], text = ''): AIResponse => ({
  message: { role: 'assistant', content: text, toolCalls: calls },
  stopReason: calls.length ? 'tool_calls' : 'completed',
  usage: { inputTokens: 50, outputTokens: 25 },
});

export async function run30MessagesTest(isLive = false) {
  const reminderPort = createSyntheticReminders();
  const taskPort = createSyntheticTasks();

  const reminderTools = createReminderTools(reminderPort);
  const taskTools = createTaskTools(taskPort);
  const baseRegistry = new ToolRegistry([...reminderTools, ...taskTools]);
  const agendaTools = createAgendaTools(baseRegistry);
  const registry = new ToolRegistry([...reminderTools, ...taskTools, ...agendaTools]);

  // 15 user turns = 30 total conversation messages (15 user + 15 assistant)
  const script = [
    // Turn 1: Create reminder (scheduled commitment)
    { text: 'Quiero que me recuerdes en 10 minutos que debo irme a dormir' },
    // Turn 2: Inside L1 (turn 1 was 1 turn ago, <= 3 turns). Should answer directly from working memory references!
    { text: '¿A qué hora me debo dormir?' },
    // Turn 3: Create task
    { text: 'Agrega una tarea: Comprar café para mañana' },
    // Turn 4: Conversational dialogue
    { text: '¿Cuál es la capital de Colombia?' },
    // Turn 5: Conversational dialogue
    { text: 'Recomiéndame un buen libro de ciencia ficción' },
    // Turn 6: Create task
    { text: 'Anota otra tarea: Revisar métricas del servidor' },
    // Turn 7: Conversational dialogue
    { text: 'Cuéntame un chiste corto' },
    // Turn 8: Conversational dialogue
    { text: '¿Qué día de la semana es hoy según tu reloj?' },
    // Turn 9: Conversational dialogue
    { text: '¿Por qué el cielo en Marte se ve diferente?' },
    // Turn 10: Conversational dialogue
    { text: 'Dame un consejo rápido de productividad' },
    // Turn 11: Create task
    { text: 'Crea una tarea para comprar fruta' },
    // Turn 12: Conversational dialogue
    { text: '¿Qué opinas sobre tomar té verde en vez de café?' },
    // Turn 13: Conversational dialogue
    { text: 'Dame una frase motivacional corta para cerrar el día' },
    // Turn 14: Conversational dialogue
    { text: '¿Cuánto tiempo tarda la luz del sol en llegar a la Tierra?' },
    // Turn 15: Outside L1 (14 turns later). Reminder has rolled out of references. Should trigger L2 retrieval via tools!
    { text: '¿A qué hora era que me tenía que ir a dormir hoy?' },
  ];

  let liveProvider: OpenRouterProvider | null = null;
  if (isLive) {
    const envFile = resolve(process.cwd(), '.env');
    const env = existsSync(envFile) ? parse(readFileSync(envFile)) : process.env;
    liveProvider = createConfiguredAIProvider({
      apiKey: env.OPENROUTER_API_KEY,
      env: { ...env, OPENROUTER_PRIMARY_TIMEOUT_MS: '25000' },
      estimateInputTokens: estimateBoundedInput,
      onAttempt: attempt => {
        console.log(`[OpenRouter attempt] model: ${attempt.route?.model ?? 'default'}, prompt: ${attempt.promptTokens ?? '?'}, completion: ${attempt.completionTokens ?? '?'}`);
      },
    });
  }

const decide = (reply: string): AIResponse => answer([
  { id: 'dec', name: 'conversation_decide', arguments: { ready: [], reply } },
]);

const decideWithAction = (tool: string, args: Record<string, unknown>, key = 'k1'): AIResponse => answer([
  { id: 'dec', name: 'conversation_decide', arguments: { ready: [{ key, tool }] } },
  { id: 'act', name: tool, arguments: { decisionItem: key, turnDisposition: 'finish', ...args } },
]);

// Realistic mock responses for offline deterministic run
let mockStep = 0;
const mockResponses: AIResponse[] = [
  // Turn 1: create reminder
  decideWithAction('reminder_create', { content: 'Debes irte a dormir', delayMinutes: 10 }, 'rem1'),

  // Turn 2 (L1): Answers directly from references without read tools!
  decide('Debes irte a dormir a las 7:02 PM (en 10 minutos).'),

  // Turn 3: Task create
  decideWithAction('task_create', { title: 'Comprar café para mañana' }, 't1'),

  // Turn 4: Dialogue
  decide('La capital de Colombia es Bogotá.'),

  // Turn 5: Dialogue
  decide('Te recomiendo "Crónicas marcianas" de Ray Bradbury.'),

  // Turn 6: Task create
  decideWithAction('task_create', { title: 'Revisar métricas del servidor' }, 't2'),

  // Turn 7: Dialogue
  decide('¿Por qué los pájaros no usan Facebook? Porque ya tienen Twitter.'),

  // Turn 8: Dialogue
  decide('Hoy es jueves 15 de octubre de 2026.'),

  // Turn 9: Dialogue
  decide('En Marte los atardeceres son de color azul debido a cómo el polvo dispersa la luz.'),

  // Turn 10: Dialogue
  decide('La técnica Pomodoro es excelente: 25 minutos de foco y 5 de descanso.'),

  // Turn 11: Task create
  decideWithAction('task_create', { title: 'comprar fruta' }, 't3'),

  // Turn 12: Dialogue
  decide('El café despierta rápido, pero el té da una energía más constante y relajada.'),

  // Turn 13: Dialogue
  decide('El descanso de hoy es la energía para conquistar mañana.'),

  // Turn 14: Dialogue
  decide('La luz del Sol tarda aproximadamente 8 minutos y 20 segundos en llegar a la Tierra.'),

  // Turn 15 (L2): Reminders not in references -> calls agenda_read or tools_select(agenda_read)
  answer([{ id: 'sel1', name: 'tools_select', arguments: { name: 'agenda_read' } }]),
  answer([{ id: 'r1', name: 'agenda_read', arguments: { scope: 'today', turnDisposition: 'finish' } }]),
  decide('Tenés programado un recordatorio para irte a dormir a las 7:02 PM.'),
];

  let conversation: ProductivityConversation | undefined = undefined;
  const turnLogs: { turn: number; user: string; reply: string; toolsCalled: string[]; referencesCount: number }[] = [];

  const schema = z.object({
    messages: aiTranscriptSchema,
    tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: jsonObjectSchema })),
  });

  for (let index = 0; index < script.length; index++) {
    const turn = script[index]!;
    console.log(`\n>>> STARTING TURN ${index + 1}: "${turn.text}"`);
    const turnToolsCalled: string[] = [];
    let turnReferencesCount = 0;

    const turnP = isLive && liveProvider ? liveProvider.forTurn() : null;

    const provider = turnP ? {
      capabilities: turnP.capabilities,
      forTurn() { return this; },
      estimateNativeInput: (input: any) => turnP.estimateNativeInput?.(input) ?? estimateBoundedInput(input),
      complete: async (req: any) => {
        const systemMsg = req.messages.find((m: any) => m.role === 'system');
        if (systemMsg) {
          for (const line of systemMsg.content.split('\n')) {
            if (line.includes('"references":')) {
              try {
                const parsed = JSON.parse(line.trim());
                if (parsed.references?.reminders) {
                  turnReferencesCount = parsed.references.reminders.length;
                  break;
                }
              } catch {}
            }
          }
        }
        const resp = await turnP.complete(req);
        if (resp.message.toolCalls) {
          for (const tc of resp.message.toolCalls) turnToolsCalled.push(tc.name);
        }
        return resp;
      },
    } : {
      capabilities: { toolCalling: true, structuredOutput: true },
      forTurn() { return this; },
      complete: async (req: any) => {
        const systemMsg = req.messages.find((m: any) => m.role === 'system');
        if (systemMsg) {
          if (index === 1) console.log('TURN 2 SYSTEM MSG CONTENT:\n', systemMsg.content);
          for (const line of systemMsg.content.split('\n')) {
            if (line.includes('"references":')) {
              try {
                const parsed = JSON.parse(line.trim());
                if (parsed.references?.reminders) {
                  turnReferencesCount = parsed.references.reminders.length;
                  break;
                }
              } catch {}
            }
          }
        }
        const stepIndex = mockStep++;
        const resp = mockResponses[stepIndex] ?? answer([], 'Respuesta por defecto.');
        if (resp.message.toolCalls) {
          for (const tc of resp.message.toolCalls) turnToolsCalled.push(tc.name);
        }
        return resp;
      },
    };

    const context: TurnContext = {
      userId: SYNTHETIC_USER,
      runId: `run-${index + 1}`,
      requestId: `req-${index + 1}`,
      timezone: 'America/Bogota',
      language: 'es',
      referenceTimeIso: anchor,
      signal: new AbortController().signal,
      capabilities: new Set(['reminders.read', 'reminders.create', 'tasks.read', 'tasks.create', 'agenda.read']),
    };

    const scopedTools = recentToolScope(conversation?.history ?? [], registry.available(context).map(t => t.name), productivityBudget.initialTools);

    const runner = new ProductivityTurnRunner(provider as any, registry, {
      ...productivityBudget,
      ...productivityDecisionPolicy,
      continuation: 'observation_driven',
      discoverTools: true,
      compactObservations: true,
      maxPromptReferences: 5,
      initialTools: scopedTools,
      readFollowups: { reminder_read: ['reminder_cancel'] },
      estimateInputTokens: input => (liveProvider ?? wire).estimateNativeInput(schema.parse(input)),
      authorizeWrite: async () => true,
    });

    const assistant = new DurableProductivityAssistant(runner, {
      send: async message => ({ messageId: `msg-${message.id}` }),
    });

    const lease: InboundTurnLease = {
      inboundTurn: { id: context.runId, messageId: context.requestId, threadId: 'thread-30', response: {} },
      signal: context.signal,
      assertActive: async () => {},
      checkpoint: async () => {},
    };

    const handled = await withTurnLease(lease, () =>
      assistant.handle(turn.text, context, 'thread-30', conversation)
    );

    conversation = handled.conversation;
    turnLogs.push({
      turn: index + 1,
      user: turn.text,
      reply: handled.reply.text,
      toolsCalled: turnToolsCalled,
      referencesCount: turnReferencesCount,
    });
  }

  return { turnLogs, totalMessages: conversation?.history.length ?? 0 };
}

if (process.argv[1]?.endsWith('v2-l1-l2-30-messages.ts')) {
  const isLive = process.argv.includes('--live');
  console.log(`Running 30-message conversation test (mode: ${isLive ? 'LIVE OpenRouter' : 'OFFLINE mock'})...\n`);
  run30MessagesTest(isLive).then(res => {
    console.log(`=== RESULTS (${res.totalMessages} total history messages: ${res.turnLogs.length} user + ${res.turnLogs.length} assistant) ===\n`);
    for (const log of res.turnLogs) {
      console.log(`Turn ${log.turn}: "${log.user}"`);
      console.log(`  -> References reminders in prompt: ${log.referencesCount}`);
      console.log(`  -> Tools called: [${log.toolsCalled.join(', ')}]`);
      console.log(`  -> Hermes: "${log.reply}"\n`);
    }

    const turn2 = res.turnLogs[1]!;
    const lastTurn = res.turnLogs.at(-1)!;

    console.log('=== VERIFICATION CRITERIA ===');
    const l1Pass = turn2.referencesCount > 0 && !turn2.toolsCalled.some(t => t.includes('read') || t.includes('agenda'));
    console.log(`[L1 Tier] Turn 2 answered from working memory cache: ${l1Pass ? 'PASS (references.reminders present, 0 read tools called)' : 'FAIL'}`);

    const l2RolledOut = lastTurn.referencesCount === 0;
    console.log(`[L1 Eviction] Turn 15 rolled out of L1 cache: ${l2RolledOut ? 'PASS (0 references in prompt)' : 'FAIL'}`);

    const l2Retrieval = lastTurn.toolsCalled.some(t => t.includes('read') || t.includes('select'));
    console.log(`[L2 Retrieval] Turn 15 triggered retrieval via tools: ${l2Retrieval ? `PASS ([${lastTurn.toolsCalled.join(', ')}])` : 'FAIL'}`);

    if (!l1Pass || !l2RolledOut || !l2Retrieval) {
      console.error('\n❌ Some verification criteria failed!');
      process.exit(1);
    }

    console.log('\n✅ ALL CRITERIA PASSED! 30-message conversation verified L1 & L2 behavior.');
    process.exit(0);
  }).catch(err => {
    console.error('Test error:', err);
    process.exit(1);
  });
}
