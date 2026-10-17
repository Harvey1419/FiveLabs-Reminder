/** Real configured model + production calendar stack; Google/storage/delivery are isolated. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parse } from 'dotenv';
import { OpenRouterProvider, estimateBoundedInput, type CompletionRequest } from '@templelabs/ai';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import type { ProductivityConversation, TurnContext } from '@templelabs/contracts';
import { ToolRegistry, createTaskTools, createProjectTools, createReminderTools, createCalendarTools,
  createMemoryTools, createSubscriptionTools, createEntityTools, createAgendaTools } from '@templelabs/tools';
import { DurableProductivityAssistant } from '../../src/adapters/agent-core/durable-productivity-assistant.js';
import { withTurnLease } from '../../src/agent/core/turn-lease.js';
import { createGatewayRouting } from '../../src/agent/providers/gateway-routing.js';
import { nativeProductivityPolicy } from '../../src/adapters/agent-core/native-productivity-policy.js';
import { configuredRoutes, createSyntheticReminders, SYNTHETIC_USER } from './v2-fluent-conversation-suite2.js';
import { createConservativeEvaluationTransport } from './conservative-evaluation-transport.js';
import { calendarCorrectionFixture, calendarAnchor } from './calendar-correction-fixture.js';

const turns = [
  { text: 'Hola, Hermes. Recuérdame, por favor, en 15 minutos, tratar de adelantar la entrega de aire, la entrega de escritorio y la entrega de lavadora.', action: 'reminder_create' },
  { text: '¿Qué eventos tengo en mi Google Calendar próximos?', read: 'upcoming', names: ['Lucho'] },
  { text: 'Para el 2 de enero, añadirlo al calendario, cumpleaños, trena.', action: 'create', date: '2027-01-02', name: 'Trena' },
  { text: 'Trina no trena', action: 'update', date: '2027-01-02', name: 'Trina' },
  { text: 'Eso que pusiste ahí para el 2 de enero es cumpleaños trina, no trena.', date: '2027-01-02', name: 'Trina' },
  { text: 'El evento del 2 de enero es trina, no trena.', date: '2027-01-02', name: 'Trina' },
  { text: 'Muéstrame qué eventos tengo para el 2 de enero.', read: '2027-01-02', names: ['Trina'] },
  { text: 'Añade también el cumpleaños de Rosa el 30 de enero.', action: 'create', date: '2027-01-30', name: 'Rosa' },
  { text: 'Rita, no Rosa.', action: 'update', date: '2027-01-30', name: 'Rita' },
  { text: 'Muéstrame los del 30 de enero.', read: '2027-01-30', names: ['Rita'] },
  { text: 'Al cumpleaños de Trina del 2 de enero cámbiale solo el título a Cumpleaños de Trina Pérez.', action: 'update', date: '2027-01-02', name: 'Trina Pérez' },
  { text: 'Muéstrame qué eventos tengo para el 2 de enero.', read: '2027-01-02', names: ['Trina Pérez'] },
];

async function main() {
  if (!process.argv.includes('--live')) { console.log(JSON.stringify({ mode: 'plan_only', turns }, null, 2)); return; }
  const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
  if (!output || !/^odd\/evidence\/[a-z0-9-]+\.json$/.test(output) || existsSync(output)) throw new Error('New evidence path required');
  const env = { ...parse(readFileSync('.env')), ...process.env };
  const key = createGatewayRouting({ getEnvironment: () => env }).getOpenRouterApiKey();
  if (!key) throw new Error('Missing configured key');
  const routeIndex = process.argv.includes('--secondary') ? 1 : 0;
  const routes = configuredRoutes(env).slice(routeIndex, routeIndex + 1), route = routes[0]!;
  const pricing = await fetch(`https://openrouter.ai/api/v1/models/${route.model}/endpoints`);
  if (!pricing.ok) throw new Error('Pricing verification failed');
  const endpoints = (await pricing.json() as { data: { endpoints: { provider_name: string; tag?: string; pricing: Record<string, string> }[] } }).data.endpoints
    .filter(e => route.providers.some(p => p.toLowerCase() === e.provider_name.toLowerCase() || p === e.tag));
  if (!endpoints.length || endpoints.some(e => Number(e.pricing.request ?? 0) !== 0)) throw new Error('Unverified pricing');
  const rates = { [route.model]: { prompt: Math.max(...endpoints.map(e => Number(e.pricing.prompt))), completion: Math.max(...endpoints.map(e => Number(e.pricing.completion))) } };
  const transport = createConservativeEvaluationTransport({ fetch: globalThis.fetch, rates, maxCalls: 60, maxUsd: 0.25 });
  const source = new OpenRouterProvider({ apiKey: key, routes, fetch: transport.fetch, estimateInputTokens: estimateBoundedInput });
  const fixture = calendarCorrectionFixture(), reminders = createSyntheticReminders();
  fixture.events.push({ id: 'old-lucho', summary: 'Cumpleaños de Lucho', start: '2026-11-29', end: '2026-11-30', isAllDay: true });
  const unavailable = async () => ({ status: 'validation_failed' as const, code: 'OUTSIDE_LOCAL_SCENARIO', observation: 'Unrequested domain in local fixture.' });
  const definitions = [...createTaskTools({ execute: unavailable }), ...createCalendarTools(fixture.port), ...createReminderTools(reminders),
    ...createMemoryTools({ execute: unavailable }), ...createProjectTools({ execute: unavailable }),
    ...createSubscriptionTools({ execute: unavailable }), ...createEntityTools({ execute: unavailable })];
  const registry = new ToolRegistry([...definitions, ...createAgendaTools(new ToolRegistry(definitions))]);
  const capabilities = new Set([...definitions.map(tool => tool.requiredCapability), 'agenda.read', 'reminders.pro']);
  // An old incomplete request must never be resumed while fulfilling a new one.
  let conversation: ProductivityConversation = { userId: SYNTHETIC_USER, reminders: [], tasks: [], events: [], handledRequestIds: [], history: [
    { role: 'user', content: 'Pon en mi calendar y recuérdame que el 29 de noviembre es el cumpleaños de Lucho.' },
    { role: 'assistant', content: 'No pude completar esa solicitud.', toolCalls: [] },
  ] };
  const report = { policy: nativeProductivityPolicy, routes, rates, productionWrites: 0, WhatsAppSends: 0,
    boundary: 'Real calendar domain port, service and executor; synthetic authenticated Google API',
    catalogue: definitions.map(t => t.specification.name), turns: [] as Record<string, unknown>[], passed: 0, failed: 0, budget: transport.report() };
  for (const [index, turn] of turns.entries()) {
    const before = structuredClone(fixture.events), calStart = fixture.operations.length, reminderStart = reminders.operations.length;
    const requests: { tools: string[]; calls: import('@templelabs/contracts').ToolCall[]; inputEstimate: number; userTurns: number; messages: CompletionRequest['messages'] }[] = [];
    const provider = source.forTurn();
    const context: TurnContext = { userId: SYNTHETIC_USER, runId: `calendar-${index}`, requestId: `calendar-${index}`, language: 'es',
      timezone: fixture.user.timezone, referenceTimeIso: calendarAnchor, capabilities, signal: new AbortController().signal };
    const runner = new ProductivityTurnRunner({ capabilities: provider.capabilities, complete: async (request: CompletionRequest) => {
      const response = await provider.complete(request);
      requests.push({ tools: request.tools.map(t => t.name), calls: response.message.toolCalls, inputEstimate: provider.estimateNativeInput(request),
        userTurns: request.messages.filter(m => m.role === 'user').length, messages: request.messages });
      return response;
    } }, registry, { ...nativeProductivityPolicy, compactObservations: true, maxPromptReferences: 5,
      estimateInputTokens: input => provider.estimateNativeInput(input as CompletionRequest), authorizeWrite: async () => true });
    const assistant = new DurableProductivityAssistant(runner, { send: async message => ({ messageId: `local:${message.id}` }) });
    const result = await withTurnLease({ inboundTurn: { id: context.runId, messageId: context.requestId, threadId: 'local-calendar', response: {} },
      signal: context.signal, assertActive: async () => {}, checkpoint: async () => {} }, () => assistant.handle(turn.text, context, 'local-calendar', conversation));
    conversation = result.conversation;
    const calendarWrites = fixture.operations.slice(calStart), reminderWrites = reminders.operations.slice(reminderStart).filter(o => o.wrote);
    const checks: { name: string; pass: boolean }[] = [];
    const check = (name: string, pass: boolean) => checks.push({ name, pass });
    check('no failed outcomes or limit notices', !result.uiPayload.notices.length && result.uiPayload.items.every(i => i.status === 'success'));
    check('no unrelated reminder writes', reminderWrites.length === (turn.action === 'reminder_create' ? 1 : 0));
    if (turn.action === 'reminder_create') check('exact relative reminder time', reminders.snapshot().some(r => !!r.sendAt && Date.parse(r.sendAt) === Date.parse('2026-10-17T16:50:00.000Z')));
    if (turn.action === 'create' || turn.action === 'update') check('exact requested calendar write', calendarWrites.length === 1 && calendarWrites[0]?.operation === turn.action);
    else check('no calendar creation/deletion or unrelated write', calendarWrites.every(w => turn.date && w.operation === 'update') && calendarWrites.length <= (turn.date ? 1 : 0));
    if (turn.date) {
      const matching = fixture.events.filter(e => e.start === turn.date);
      check('one event with corrected name on original civil date', matching.length === 1 && String(matching[0]?.summary).toLowerCase().includes(turn.name!.toLowerCase()));
      check('birthday title preserved', matching.length === 1 && String(matching[0]?.summary).toLowerCase().includes('cumpleaños'));
      if (turn.action !== 'create') check('stable ID and unchanged dates', matching[0]?.id === before.find(e => e.start === turn.date)?.id
        && matching[0]?.end === before.find(e => e.start === turn.date)?.end);
    }
    if (turn.read) {
      check('date in scope without accidental text filter', requests.some(r => Array.isArray(r.calls) && r.calls.some(c => c.name === 'calendar_read'
        && c.arguments.scope === turn.read && !c.arguments.query)));
      check('correct rendered names', turn.names!.every(name => result.reply.text.toLowerCase().includes(name.toLowerCase())));
    }
    check('unrelated calendar events unchanged', before.filter(e => e.start !== turn.date).every(e => JSON.stringify(e) === JSON.stringify(fixture.events.find(next => next.id === e.id))));
    const pass = checks.every(c => c.pass); report.passed += Number(pass); report.failed += Number(!pass);
    report.turns.push({ number: index + 1, text: turn.text, reply: result.reply.text, checks, pass, requests,
      calendarWrites, notices: result.uiPayload.notices, events: structuredClone(fixture.events) });
    report.budget = transport.report(); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ turn: index + 1, pass, failedChecks: checks.filter(c => !c.pass).map(c => c.name), reply: result.reply.text }));
  }
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, budget: report.budget, output }));
  if (report.failed) process.exitCode = 1;
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Calendar evaluation failed'); process.exitCode = 1; });
