import { productivityBudget, productivityDecisionPolicy } from '../../src/adapters/agent-core/productivity-budget.js';
import { z } from 'zod';
import { writeFileSync } from 'node:fs';
import { ProductivityTurnRunner, type ProductivityExecutionJournal } from '@templelabs/agent-core';
import { MockAIProvider, OpenRouterProvider, estimateBoundedInput } from '@templelabs/ai';
import { createReminderTools, createTaskTools, createCalendarTools, ToolRegistry, type ReminderDomainPort } from '@templelabs/tools';
import { type AIResponse, type ProductivityConversation, type TurnContext, type ToolCall, productivityItemSchema, aiTranscriptSchema, jsonObjectSchema } from '@templelabs/contracts';

const id = '22222222-2222-4222-8222-222222222222';
const reply = (toolCalls: ToolCall[] = []): AIResponse => ({ message: { role: 'assistant', content: toolCalls.length ? '' : 'Aquí estoy. Vamos paso a paso.', toolCalls },
  stopReason: toolCalls.length ? 'tool_calls' : 'completed', usage: { inputTokens: 0, outputTokens: 0 } });
const context: TurnContext = { userId: 'fixture-owner', runId: 'fixture-run', requestId: 'fixture-request', timezone: 'America/Bogota', language: 'es',
  referenceTimeIso: '2026-10-14T15:00:00Z', signal: new AbortController().signal, capabilities: new Set(['reminders.read', 'reminders.cancel']) };
const old: ProductivityConversation = { userId: context.userId, history: Array.from({ length: 6 }, (_, index) => ({
  ...(index % 2 ? { role: 'assistant' as const, toolCalls: [] } : { role: 'user' as const }),
  content: `Intercambio ${index}. ` + 'Estamos organizando el día y sus pendientes. '.repeat(8),
})), tasks: [], reminders: [], events: [], handledRequestIds: ['previous-request'], legacyHandoff: {
  sourceRunId: 'old-run', sourceRequestId: 'previous-request', referenceGaps: Array.from({ length: 50 }, (_, index) => ({
    id: `old-reference-${index}`, type: 'reminder', position: index + 1, title: 'Detalle histórico '.repeat(11), reason: 'missing' as const,
  })),
} };
const cancellation = [reply([{ id: 'select', name: 'tools_select', arguments: { name: 'reminder_read' } }]),
  reply([{ id: 'read', name: 'reminder_read', arguments: { query: 'amoxicilina' } }]),
  reply([{ id: 'cancel', name: 'reminder_cancel', arguments: { reminderId: id } }]), reply()];
const dialogue = reply([{ id: 'dialogue', name: 'conversation_decide', arguments: { ready: [], reply: 'Aquí estoy. Vamos paso a paso.' } }]);
const cases = [
  { name: 'greeting', text: 'Buenos días', history: undefined, script: [dialogue], writes: 0 },
  { name: 'greeting_with_legacy_history_and_gaps', text: 'Buenos días, ¿seguimos organizando el día?', history: old, script: [dialogue], writes: 0 },
  { name: 'read_then_cancel', text: '¿Podrías eliminar el recordatorio de la moxicilina?', history: undefined, script: cancellation, writes: 1 },
  { name: 'read_then_cancel_with_legacy_history_and_gaps', text: '¿Podrías eliminar el recordatorio de la moxicilina?', history: old, script: cancellation, writes: 1 },
  ...[1500, 3000, 5000].map(length => ({ name: `long_current_input_${length}_chars`, text: ('Estoy preparando mi semana. Tengo varias reuniones y necesito priorizar los pendientes sin perder el descanso. ').repeat(50).slice(0, length), history: old, script: [dialogue], writes: 0 })),
];
const results = [];
for (const fixture of cases) for (const budget of [...new Set([1800, 2500, productivityBudget.maxInputTokens])]) {
  const calls: string[] = [];
  const port: ReminderDomainPort = { async execute(request, scoped, operationId) {
    calls.push(request.operation);
    const record = { id, content: 'Amoxicilina 500 mg', sendAt: '2026-10-15T08:25:00Z', recurrence: 'daily', isAdvanceNotice: false,
      parentReminderId: null, requiresConfirmation: false, acknowledgedAt: null, status: request.operation === 'cancel' ? 'cancelled' as const : 'pending' as const };
    return { status: 'success', data: { operation: request.operation, records: [record], complete: true, coverage: request.operation === 'read' ? 'bounded_list' : 'operation',
      rejections: [], presentation: { canonicalCard: null, questions: [], cta: null } },
    receipt: { userId: scoped.userId, operationId, toolName: `reminder_${request.operation}`, resourceIds: [id] }, observation: 'Verified fixture result' };
  } };
  const provider = new MockAIProvider(fixture.script.map(response => ({ response })));
  const wire = new OpenRouterProvider({ apiKey: 'offline-fixture', routes: [{ id: 'primary', model: 'openai/gpt-oss-120b', providers: ['groq'], timeoutMs: 1000 }], estimateInputTokens: estimateBoundedInput });
  const runner = new ProductivityTurnRunner(provider, new ToolRegistry([
    ...createReminderTools(port), ...createTaskTools({ execute: async () => { throw new Error('Unexpected task fixture dispatch'); } }),
    ...createCalendarTools({ execute: async () => { throw new Error('Unexpected calendar fixture dispatch'); } }),
  ]), { ...productivityDecisionPolicy, continuation: 'observation_driven', discoverTools: true, compactObservations: true, continuationReserveTokens: 256,
    readFollowups: { reminder_read: ['reminder_cancel'], task_read: ['task_delete'], calendar_read: ['calendar_delete'] },
    maxPromptReferences: 5, maxInputTokens: budget, maxTotalTokens: 12000, maxModelSteps: 6, maxToolCalls: 8, maxOutputTokens: 768,
    estimateInputTokens: input => wire.estimateNativeInput(z.object({ messages: aiTranscriptSchema, tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: jsonObjectSchema })) }).parse(input)), authorizeWrite: async () => true });
  const journal: ProductivityExecutionJournal = { beforeDispatch: async () => {}, afterOutcome: async (_call, item) => { productivityItemSchema.parse(item); } };
  let result;
  let error: string | null = null;
  try { result = await runner.run(fixture.text, context, fixture.history, journal); }
  catch (failure) { if (!(failure instanceof Error) || failure.name !== 'ContextLimitError') throw failure; error = failure.name; }
  const estimates = provider.requests.map(request => wire.estimateNativeInput(request));
  const writes = calls.filter(operation => operation !== 'read').length;
  results.push({ case: fixture.name, budget, decisionControlAdvertised: provider.requests.some(request => request.tools.some(tool => tool.name === 'conversation_decide')), complete: Boolean(result && result.uiPayload.notices.length === 0 && writes === fixture.writes && result.conversationReply),
    error, notices: result?.uiPayload.notices ?? [], domainCalls: calls, writes, modelRequests: estimates.length,
    inputEstimates: estimates, maxInputEstimate: Math.max(0, ...estimates), totalInputEstimate: estimates.reduce((a, b) => a + b, 0),
    historicalHintsProjected: provider.requests.some(request => JSON.stringify(request.messages).includes('historicalReferenceGaps')),
    originalHistoryMessages: fixture.history?.history.length ?? 0,
    durableHistoryMessages: result?.conversation.history.length ?? 0 });
  if (budget === productivityBudget.maxInputTokens && fixture.name !== 'long_current_input_5000_chars' && !results.at(-1)!.complete) throw new Error('Expected fixture completion failed');
  if (estimates.some(estimate => estimate > budget) || writes > fixture.writes) throw new Error('Budget or mutation safety regression');
}
const report = { version: 1, productionPolicy: { ...productivityBudget, ...productivityDecisionPolicy }, productionInputBudget: productivityBudget.maxInputTokens, mode: 'offline_deterministic_capacity_comparison',
  methodology: 'Same scripted responses, core loop options and full atomic registry for each budget; no inference, storage, delivery or deployments. Input estimates include the OpenRouter wire envelope.',
  limits: 'Measures context capacity and protocol completion only. Does not measure intelligence, live model quality, provider token usage, latency or actual cost. Long-input cases are synthetic stress fixtures.', results };
const output = process.argv[2];
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
