import { readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'dotenv';
import { z } from 'zod';
import { OpenRouterProvider, estimateBoundedInput, type AIProvider, type OpenRouterRoute, type OpenRouterAttempt } from '@templelabs/ai';
import { ProductivityTurnRunner, type ToolSelectionDiagnostic } from '@templelabs/agent-core';
import { aiTranscriptSchema, jsonObjectSchema, productivityCheckpointSchema, type JsonObject, type ProductivityConversation, type ReminderRecord, type ReminderRequest, type TurnContext } from '@templelabs/contracts';
import { createReminderTools, ToolRegistry, type ReminderDomainPort } from '@templelabs/tools';
import { DurableProductivityAssistant } from '../../src/adapters/agent-core/durable-productivity-assistant.js';
import { productivityBudget, productivityDecisionPolicy } from '../../src/adapters/agent-core/productivity-budget.js';
import { recentToolScope } from '../../src/adapters/agent-core/recent-tool-scope.js';
import { withTurnLease, type InboundTurnLease } from '../../src/agent/core/turn-lease.js';
import { createGatewayRouting } from '../../src/agent/providers/gateway-routing.js';
import { createBudgetedTransport, type Rate } from './live-evaluation-budget.js';

export const SYNTHETIC_USER = 'fluent-eval-synthetic-owner';
const anchor = '2026-10-11T17:49:00Z';
const uuid = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const firstId = uuid(1), secondId = uuid(2), thirdId = uuid(3);
const question = '¿El recordatorio pendiente es para hoy o para mañana?';
const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
type Expectation = { operation?: 'create' | 'update' | 'cancel'; id?: string; time?: string; content?: string; readIds?: string[]; reply?: string[]; clarification?: boolean };
export const turns: readonly { text: string; expected: Expectation }[] = [
  { text: 'Recuérdame preparar reunión hoy a las 4 PM y enviar informe a las 9 AM, pero no sé si hoy o mañana', expected: { operation: 'create', id: firstId, time: '2026-10-11T21:00:00Z', content: 'preparar reunion', clarification: true, reply: ['reunión', '4:00 PM'] } },
  { text: 'mañana', expected: { operation: 'create', id: secondId, time: '2026-10-12T14:00:00Z', content: 'enviar informe', clarification: false, reply: ['informe', '9:00 AM'] } },
  { text: 'Muéstrame los recordatorios de hoy.', expected: { readIds: [firstId] } },
  { text: '¿Y los de mañana? Muéstramelos.', expected: { readIds: [secondId] } },
  { text: 'El primero de esa lista de mañana, cámbialo a las 10 AM de mañana.', expected: { operation: 'update', id: secondId, time: '2026-10-12T15:00:00Z' } },
  { text: 'Ahora muéstrame los recordatorios de hoy otra vez.', expected: { readIds: [firstId] } },
  { text: 'Ese primero de hoy, pásalo a las 5 PM de hoy.', expected: { operation: 'update', id: firstId, time: '2026-10-11T22:00:00Z' } },
  { text: 'Lista todos mis recordatorios pendientes en orden de fecha y hora.', expected: { readIds: [firstId, secondId] } },
  { text: 'Cancela el segundo de esa lista.', expected: { operation: 'cancel', id: secondId } },
  { text: 'Muéstrame qué recordatorios quedan para mañana.', expected: { readIds: [] } },
  { text: 'Recuérdame comprar pan mañana a las 8 AM.', expected: { operation: 'create', id: thirdId, time: '2026-10-12T13:00:00Z', content: 'comprar pan' } },
  { text: 'Lista mis recordatorios de mañana.', expected: { readIds: [thirdId] } },
  { text: 'Al primero de esa lista cámbiale solo el texto a Comprar pan integral.', expected: { operation: 'update', id: thirdId, content: 'comprar pan integral' } },
  { text: 'Cancela el recordatorio con ID 99999999-9999-4999-8999-999999999999. Si no existe no cambies nada.', expected: {} },
  { text: '¿Cómo se llama ahora el recordatorio del pan de mañana?', expected: { reply: ['pan integral'] } },
  { text: 'Mi palabra de prueba en esta conversación es colibrí. Solo recuérdala aquí, sin crear ni cambiar recordatorios.', expected: {} },
  { text: '¿Cuál es mi palabra de prueba?', expected: { reply: ['colibrí'] } },
  { text: 'Cancela el recordatorio Comprar pan integral de mañana.', expected: { operation: 'cancel', id: thirdId } },
  { text: 'Muéstrame todos mis recordatorios pendientes.', expected: { readIds: [firstId] } },
  { text: '¿A qué hora quedó el recordatorio de preparar reunión de hoy? No lo cambies.', expected: { reply: ['5:00 PM'] } },
];
export type Operation = { request: ReminderRequest; ids: string[]; wrote: boolean; operationId?: string; replay?: boolean };
export type Check = { name: string; pass: boolean };
type Evidence = { before: ReminderRecord[]; after: ReminderRecord[]; operations: Operation[]; reads: ReminderRecord[][]; reply: string; clarification: unknown };

/** Checks use observed domain outcomes, never planned tool calls as success evidence. */
export function gradeTurn(index: number, evidence: Evidence): Check[] {
  const expected = turns[index]!.expected;
  const checks: Check[] = [];
  const check = (name: string, pass: boolean) => checks.push({ name, pass });
  const writes = evidence.operations.filter(o => o.wrote);
  check('exact write count', writes.length === (expected.operation ? 1 : 0));
  if (expected.operation) {
    const write = writes[0];
    const target = evidence.after.find(r => r.id === expected.id);
    check('operation and stable target', write?.request.operation === expected.operation && write.ids.length === 1 && write.ids[0] === expected.id);
    if (expected.time) check('exact local date/time', !!target?.sendAt && Date.parse(target.sendAt) === Date.parse(expected.time));
    if (expected.content) check('requested content', !!target && fold(target.content).includes(expected.content));
    if (expected.operation === 'cancel') check('target cancelled', target?.status === 'cancelled');
    if (expected.operation === 'create') check('one new record only', evidence.after.length === evidence.before.length + 1 && !evidence.before.some(r => r.id === expected.id));
    else check('no added or removed records', evidence.after.length === evidence.before.length);
    const prior = evidence.before.find(r => r.id === expected.id);
    if (prior && target) {
      const allowed = expected.operation === 'cancel' ? ['status'] : [...(expected.time ? ['sendAt'] : []), ...(expected.content ? ['content'] : [])];
      check('unrequested target fields unchanged', Object.keys(prior).filter(k => !allowed.includes(k)).every(k => prior[k as keyof ReminderRecord] === target[k as keyof ReminderRecord]));
    }
  } else check('stored records unchanged', JSON.stringify(evidence.after) === JSON.stringify(evidence.before));
  check('unrelated records unchanged', evidence.before.filter(r => r.id !== expected.id).every(r => JSON.stringify(evidence.after.find(next => next.id === r.id)) === JSON.stringify(r)));
  if (expected.clarification !== undefined) {
    check('typed clarification', expected.clarification ? JSON.stringify(evidence.clarification) === JSON.stringify({ domain: 'reminders', missing: 'today_or_tomorrow' }) : evidence.clarification == null);
    check('host question', expected.clarification ? evidence.reply.endsWith(question) : !evidence.reply.includes(question));
  }
  if (expected.readIds) {
    check('read list IDs and order', evidence.reads.length > 0 && evidence.reads.every(records => JSON.stringify(records.map(r => r.id)) === JSON.stringify(expected.readIds)));
    check('read reflects stored records', evidence.reads.every(records => records.every(r => isDeepStrictEqual(evidence.after.find(next => next.id === r.id), r))));
    check('host lists returned content', evidence.reads.every(records => records.every(r => fold(evidence.reply).includes(fold(r.content)))));
  }
  for (const text of expected.reply ?? []) check(`reply includes ${text}`, fold(evidence.reply).includes(fold(text)));
  return checks;
}

/** No scripted outcome injection: all mutations and lists are derived from typed inputs. */
export function createSyntheticReminders() {
  const records = new Map<string, ReminderRecord>();
  const operations: Operation[] = [];
  const receipts: unknown[] = [];
  const memo = new Map<string, { request: string; outcome: Awaited<ReturnType<ReminderDomainPort['execute']>> }>();
  let sequence = 0;
  const reject = (code: string) => ({ status: 'validation_failed' as const, code, observation: 'No synthetic write dispatched.' });
  const execute: ReminderDomainPort['execute'] = async (request, context, operationId) => {
    if (context.userId !== SYNTHETIC_USER) return reject('SYNTHETIC_OWNER_REQUIRED');
    const signature = JSON.stringify(request);
    const previous = memo.get(operationId);
    if (previous) {
      operations.push({ request: structuredClone(request), ids: [], wrote: false, operationId, replay: true });
      return previous.request === signature ? structuredClone(previous.outcome) : reject('OPERATION_ID_CONFLICT');
    }
    const op: Operation = { request: structuredClone(request), ids: [], wrote: false, operationId };
    operations.push(op);
    let selected: ReminderRecord[];
    if (request.operation === 'read') {
      const input = request.input;
      const localDate = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
      const day = localDate(context.referenceTimeIso);
      const addDays = (n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
      const weekday = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
      const filter = input.filter ?? 'upcoming';
      selected = [...records.values()].filter(r => {
        if (input.query && !fold(r.content).includes(fold(input.query))) return false;
        const date = r.sendAt ? localDate(r.sendAt) : '';
        if (filter === 'completed_today') return !!r.acknowledgedAt && localDate(r.acknowledgedAt) === day;
        if (filter === 'created_today') return true; // This run's records were all created at the fixed anchor.
        if (r.status !== 'pending') return false;
        if (filter === 'all_pending') return true;
        if (filter === 'upcoming') return !!r.sendAt && Date.parse(r.sendAt) >= Date.parse(context.referenceTimeIso);
        if (['today', 'pending_today', 'remaining_today'].includes(filter)) return date === day && (filter !== 'remaining_today' || !!r.sendAt && Date.parse(r.sendAt) >= Date.parse(context.referenceTimeIso));
        if (filter === 'tomorrow') return date === addDays(1);
        if (filter === 'this_week') return date >= addDays(-weekday) && date < addDays(7 - weekday);
        if (filter === 'next_week') return date >= addDays(7 - weekday) && date < addDays(14 - weekday);
        return date === filter;
      }).sort((a, b) => (a.sendAt ?? '').localeCompare(b.sendAt ?? '') || a.id.localeCompare(b.id)).slice(0, 50);
    } else if (request.operation === 'create') {
      const input = request.input;
      if (input.advanceMinutes !== undefined || input.nudgeIntervalMinutes !== undefined || input.maxNudges !== undefined) return reject('SYNTHETIC_POLICY_UNSUPPORTED');
      const record: ReminderRecord = { id: uuid(++sequence), content: input.content, sendAt: input.targetTimeIso, recurrence: input.recurrence ?? null, status: 'pending', isAdvanceNotice: false, parentReminderId: null, requiresConfirmation: input.requiresConfirmation ?? false, acknowledgedAt: null };
      records.set(record.id, record);
      selected = [record]; op.wrote = true;
    } else if (request.operation === 'update' || request.operation === 'cancel') {
      const record = records.get(request.input.reminderId);
      if (!record || record.status !== 'pending') return reject('REMINDER_NOT_FOUND');
      if (request.operation === 'cancel') record.status = 'cancelled';
      else {
        const input = request.input;
        if (input.deliveryPolicy !== undefined) return reject('SYNTHETIC_POLICY_UNSUPPORTED');
        if (input.content !== undefined) record.content = input.content;
        if (input.targetTimeIso !== undefined) record.sendAt = input.targetTimeIso;
        if (input.recurrence !== undefined) record.recurrence = input.recurrence;
      }
      selected = [record]; op.wrote = true;
    } else return reject('SYNTHETIC_OPERATION_UNSUPPORTED');
    op.ids = selected.map(r => r.id);
    const data = { operation: request.operation, records: structuredClone(selected), complete: true, coverage: request.operation === 'read' ? 'bounded_list' as const : 'operation' as const, rejections: [], presentation: { canonicalCard: null, questions: [], cta: null } };
    const receipt = { userId: context.userId, operationId, toolName: `reminder_${request.operation}`, resourceIds: op.ids };
    const outcome = { status: 'success' as const, data, observation: JSON.stringify(data), receipt };
    receipts.push(structuredClone(receipt));
    memo.set(operationId, { request: signature, outcome: structuredClone(outcome) });
    return outcome;
  };
  return { execute, operations, receipts, snapshot: () => structuredClone([...records.values()]) };
}

const evaluationLimits = (directed = false) => directed
  ? { userTurns: 2, maxCalls: 6, maxUsd: 0.02 }
  : { userTurns: 20, maxCalls: 60, maxUsd: 0.25 };
type NativeProvider = AIProvider & { estimateNativeInput?: OpenRouterProvider['estimateNativeInput'] };
type BudgetReport = ReturnType<ReturnType<typeof createBudgetedTransport>['report']>;
type TurnReport = { number: number; user: string; expected: Expectation; checks: Check[]; pass: boolean; reply: string; notices: string[]; calls: unknown[]; safeAttempts: unknown[]; toolSelections: ToolSelectionDiagnostic[]; transportAttempts: unknown[]; budgetAfter: BudgetReport | null; usage: unknown; operations: Operation[]; before: ReminderRecord[]; after: ReminderRecord[]; checkpoints: JsonObject[]; exception: string | null };
const emptyBudget = (): BudgetReport => ({ calls: 0, chargedUsd: 0, reservedUsd: 0, blockedReason: null, attempts: [] });
export async function runConversation(options: {
  forTurn(): NativeProvider; live?: boolean; directed?: boolean; rates?: Record<string, Rate>; budgetReport?: () => BudgetReport; attempts?: unknown[];
}) {
  const limits = evaluationLimits(options.directed);
  const script = turns.slice(0, limits.userTurns);
  const port = createSyntheticReminders();
  const registry = new ToolRegistry(createReminderTools(port).filter(tool => tool.specification.name !== 'reminder_acknowledge'));
  const report = {
    liveRequested: options.live === true, liveProof: false, directedProof: false, script, limits: { ...limits, ...productivityBudget, discoverTools: true, compactObservations: true, maxPromptReferences: 5 },
    timezone: 'America/Bogota', language: 'es', referenceTimeIso: anchor, userId: SYNTHETIC_USER,
    turns: [] as TurnReport[], passedTurns: 0, failedTurns: 0, passedChecks: 0, failedChecks: 0,
    incomplete: true, exception: null as string | null, stoppedReason: null as string | null, degraded: false,
    receipts: port.receipts, finalRecords: [] as ReminderRecord[], conversation: undefined as ProductivityConversation | undefined, budget: emptyBudget(),
  };
  let conversation: ProductivityConversation | undefined;
  const budgetReport = options.budgetReport ?? emptyBudget;
  const schema = z.object({ messages: aiTranscriptSchema, tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: jsonObjectSchema })) });
  try {
    for (const [index, turn] of script.entries()) {
      if (budgetReport().blockedReason) { report.stoppedReason = budgetReport().blockedReason; break; }
      const source = options.forTurn();
      const calls: unknown[] = [];
      const toolSelections: ToolSelectionDiagnostic[] = [];
      const attemptStart = options.attempts?.length ?? 0;
      const transportStart = budgetReport().attempts.length;
      const operationStart = port.operations.length;
      const before = port.snapshot();
      const checkpoints: JsonObject[] = [];
      const reads: ReminderRecord[][] = [];
      const provider: AIProvider = { capabilities: source.capabilities, complete: async request => {
        // A protocol correction is another model step, never an exemption from
        // the shared accounting lock observed during the preceding response.
        if (budgetReport().blockedReason) throw new Error('EVALUATION_ACCOUNTING_LOCKED');
        const result = await source.complete(request);
        calls.push({ calls: structuredClone(result.message.toolCalls), usage: result.usage, stopReason: result.stopReason });
        return result;
      } };
      const context: TurnContext = { userId: SYNTHETIC_USER, runId: `fluent-${index + 1}`, requestId: `fluent-request-${index + 1}`, timezone: 'America/Bogota', language: 'es', referenceTimeIso: anchor, signal: new AbortController().signal,
        capabilities: new Set(['reminders.read', 'reminders.create', 'reminders.update', 'reminders.cancel', 'reminders.acknowledge', 'reminders.pro']) };
      const rates = Object.values(options.rates ?? {});
      const runner = new ProductivityTurnRunner(provider, registry, {
        ...productivityBudget, ...productivityDecisionPolicy, continuation: 'observation_driven', discoverTools: true, compactObservations: true, maxPromptReferences: 5,
        onToolSelection: diagnostic => { toolSelections.push(structuredClone(diagnostic)); },
        initialTools: recentToolScope(conversation?.history ?? [], registry.available(context).map(t => t.name), productivityBudget.initialTools),
        readFollowups: { reminder_read: ['reminder_cancel'] },
        ...(rates.length ? { pricing: { inputUsdPerMillion: Math.max(...rates.map(r => r.prompt)) * 1e6, outputUsdPerMillion: Math.max(...rates.map(r => r.completion)) * 1e6 } } : {}),
        estimateInputTokens: input => source.estimateNativeInput?.(schema.parse(input)) ?? estimateBoundedInput(input),
        authorizeWrite: async (call, scoped) => scoped.userId === SYNTHETIC_USER && ['reminder_create', 'reminder_update', 'reminder_cancel'].includes(call.name),
      });
      const assistant = new DurableProductivityAssistant(runner, { send: async message => ({ messageId: `synthetic:${message.id}` }) });
      const lease: InboundTurnLease = { inboundTurn: { id: context.runId, messageId: context.requestId, threadId: 'synthetic-thread', response: {} }, signal: context.signal, assertActive: async () => {}, checkpoint: async patch => { checkpoints.push(structuredClone(patch)); } };
      const entry: TurnReport = { number: index + 1, user: turn.text, expected: turn.expected, checks: [], pass: false, reply: '', notices: [], calls, safeAttempts: [], toolSelections, transportAttempts: [], budgetAfter: null, usage: null, operations: [], before, after: before, checkpoints, exception: null };
      report.turns.push(entry);
      try {
        const result = await withTurnLease(lease, () => assistant.handle(turn.text, context, 'synthetic-thread', conversation));
        conversation = result.conversation; // Always carry the actual result, including semantic failures.
        entry.reply = result.reply.text; entry.notices = [...result.uiPayload.notices]; entry.usage = result.usage;
        for (const item of result.uiPayload.items) if (item.toolName === 'reminder_read' && item.result && 'records' in item.result) reads.push(item.result.records as ReminderRecord[]);
        entry.after = port.snapshot(); entry.operations = structuredClone(port.operations.slice(operationStart));
        entry.checks = gradeTurn(index, { before, after: entry.after, operations: entry.operations, reads, reply: entry.reply, clarification: result.uiPayload.clarification ?? null });
        const checkpoint = productivityCheckpointSchema.safeParse(checkpoints.at(-1)?.agentCoreProductivity);
        entry.checks.push({ name: 'valid transcript', pass: aiTranscriptSchema.safeParse(conversation.history).success });
        entry.checks.push({ name: 'host reply and checkpoint agree', pass: checkpoint.success && checkpoint.data.phase === 'completed' && checkpoint.data.completed?.reply.text === entry.reply && checkpoint.data.completed.conversation.history.at(-1)?.content === entry.reply });
        entry.checks.push({ name: 'no operational notices', pass: entry.notices.length === 0 });
        if (!result.usage.accountingComplete) report.stoppedReason = 'uncertain accounting';
        else if (entry.notices.includes('provider_unavailable')) report.stoppedReason = 'provider unavailable';
        // Input/context/step limits are evidence of degradation, not permission to raise policy or retry.
        if (entry.notices.includes('limit_reached')) report.degraded = true;
      } catch {
        entry.exception = 'EVALUATION_TURN_EXCEPTION'; report.exception = entry.exception; report.stoppedReason = 'turn exception';
        entry.checks.push({ name: 'turn completed', pass: false });
      } finally {
        entry.after = port.snapshot(); entry.operations = structuredClone(port.operations.slice(operationStart));
        entry.safeAttempts = structuredClone(options.attempts?.slice(attemptStart) ?? []);
        entry.pass = entry.checks.length > 0 && entry.checks.every(c => c.pass);
        report.passedTurns += Number(entry.pass); report.failedTurns += Number(!entry.pass);
        report.passedChecks += entry.checks.filter(c => c.pass).length; report.failedChecks += entry.checks.filter(c => !c.pass).length;
        report.budget = budgetReport();
        entry.transportAttempts = structuredClone(report.budget.attempts.slice(transportStart));
        entry.budgetAfter = structuredClone(report.budget);
      }
      report.stoppedReason = report.budget.blockedReason ?? report.stoppedReason;
      if (report.budget.calls >= limits.maxCalls) report.stoppedReason ??= 'call limit';
      if (report.budget.chargedUsd + report.budget.reservedUsd >= limits.maxUsd) report.stoppedReason ??= 'USD limit';
      if (report.stoppedReason) break;
    }
  } catch { report.exception = 'EVALUATION_SETUP_EXCEPTION'; report.stoppedReason ??= 'setup exception'; }
  finally {
    report.budget = budgetReport(); report.finalRecords = port.snapshot(); report.conversation = conversation;
    report.incomplete = report.turns.length !== limits.userTurns || report.exception !== null;
    const accountedProof = options.live === true && !report.incomplete && !report.stoppedReason && report.failedTurns === 0
      && report.budget.calls > 0 && !report.budget.blockedReason && report.budget.reservedUsd === 0;
    report.liveProof = !options.directed && accountedProof;
    report.directedProof = options.directed === true && accountedProof;
  }
  return report;
}

export function configuredRoutes(env: Readonly<Record<string, string | undefined>>): OpenRouterRoute[] {
  const config = createGatewayRouting({ getEnvironment: () => env }).MODEL_CONFIG.openrouter;
  const positive = (value: string | undefined, fallback: number) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  return [
    { id: 'primary', model: config.primary, providers: config.primaryProviders, timeoutMs: positive(env.OPENROUTER_PRIMARY_TIMEOUT_MS, 6000), temperature: 0, reasoning: { effort: env.OPENROUTER_PRIMARY_REASONING_EFFORT || 'medium', exclude: true } },
    { id: 'secondary', model: config.secondary, providers: config.secondaryProviders, timeoutMs: positive(env.OPENROUTER_SECONDARY_TIMEOUT_MS, 3500), temperature: 0, reasoning: { effort: env.OPENROUTER_SECONDARY_REASONING_EFFORT || 'low', exclude: true } },
    { id: 'last_resort', model: config.lastResort, providers: config.lastResortProviders, timeoutMs: positive(env.OPENROUTER_LAST_RESORT_TIMEOUT_MS, 3500), temperature: 0, minOutputTokens: 2800 },
  ];
}
const help = `Synthetic fluent evaluation (disabled by default)\nUsage: node --import tsx scripts/evals/v2-fluent-conversation.ts [--help]\n       node --import tsx scripts/evals/v2-fluent-conversation.ts --live --pricing <in-project.json> --output <new-in-project.json>\n--help     Print help without credentials, network, or files.\n--live     Explicitly enable the single paid run (parent/operator only).\n--directed Select only the first 2 turns, 6 HTTP calls, US$0.02, primary route only (no fallback).\n--pricing  Preflight JSON {rates:{model:{prompt,completion}}}; USD per TOKEN, all configured routes required.\n--output   New in-project JSON report (existing files and symlink escapes rejected).\nDefault fixed caps: 20 chained user messages, 60 HTTP inference calls, US$0.25. No overrides, automatic reruns, or semantic retries.\nWithout --live: print the 20-message plan only; no credentials, fetch, or file writes.\n`;
const project = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
function projectJson(path: string, output: boolean): string {
  const target = resolve(project, path);
  const actual = output ? resolve(realpathSync(dirname(target)), target.slice(dirname(target).length + 1)) : realpathSync(target);
  const rel = relative(project, actual);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !actual.endsWith('.json') || output && existsSync(actual)) throw new Error('INVALID_PROJECT_JSON_PATH');
  return actual;
}
/** Runtime-only selection: never install DB settings or any parsed values into process.env. */
function runtimeEnvironment(): Record<string, string> {
  const file = resolve(project, '.env');
  const values = { ...(existsSync(file) ? parse(readFileSync(file)) : {}), ...process.env };
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && (entry[0].startsWith('OPENROUTER_') || entry[0] === 'AI_API_KEY' && entry[1].startsWith('sk-or-'))));
}
export function safeAttempt(attempt: OpenRouterAttempt) {
  return structuredClone({ route: attempt.route, model: attempt.model, requestedProviders: attempt.requestedProviders, provider: attempt.provider, generationId: attempt.generationId, inputEstimate: attempt.inputEstimate, usage: attempt.usage, status: attempt.status, outcome: attempt.outcome, failureClass: attempt.failureClass,
    providerErrorCode: attempt.providerErrorCode, advertisedToolNames: attempt.advertisedToolNames,
    advertisedToolsTruncated: attempt.advertisedToolsTruncated, rejectedToolName: attempt.rejectedToolName });
}
export async function main(argv = process.argv.slice(2), print: (text: string) => void = console.log): Promise<number> {
  if (argv.length === 1 && argv[0] === '--help') { print(help); return 0; }
  let pricingPath: string | undefined, outputPath: string | undefined, live = false, directed = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live' && !live) live = true;
    else if (arg === '--directed' && !directed) directed = true;
    else if ((arg === '--pricing' && !pricingPath || arg === '--output' && !outputPath) && argv[i + 1] && !argv[i + 1]!.startsWith('--')) {
      const value = argv[++i]!; if (arg === '--pricing') pricingPath = value; else outputPath = value;
    } else { print(help); return 2; }
  }
  if (!live) {
    if (pricingPath || outputPath) { print(help); return 2; }
    print(help + '\nDRY PLAN — not live evidence\n' + turns.slice(0, evaluationLimits(directed).userTurns).map((turn, i) => `${i + 1}. ${turn.text}`).join('\n')); return 0;
  }
  if (!pricingPath || !outputPath) { print(help); return 2; }
  let output: string;
  try { output = projectJson(outputPath, true); } catch { print('Invalid output path; no inference started.'); return 2; }
  let report: unknown = { incomplete: true, exception: 'PREFLIGHT_FAILED', liveProof: false, directedProof: false, script: turns.slice(0, evaluationLimits(directed).userTurns), limits: evaluationLimits(directed), turns: [] };
  let exit = 1;
  try {
    const pricing = z.object({ rates: z.record(z.string(), z.object({ prompt: z.number().finite().nonnegative(), completion: z.number().finite().nonnegative() })) }).parse(JSON.parse(readFileSync(projectJson(pricingPath, false), 'utf8')));
    const env = runtimeEnvironment();
    const routing = createGatewayRouting({ getEnvironment: () => env });
    const key = routing.getOpenRouterApiKey();
    if (!key) throw new Error('MISSING_CREDENTIALS');
    const routes = directed ? configuredRoutes(env).slice(0, 1) : configuredRoutes(env);
    const limits = evaluationLimits(directed);
    const rates: Record<string, Rate> = {};
    for (const route of routes) { const rate = pricing.rates[route.model]; if (!rate) throw new Error('MISSING_PRICING'); rates[route.model] = rate; }
    const budget = createBudgetedTransport({ fetch: globalThis.fetch, rates, maxCalls: limits.maxCalls, maxUsd: limits.maxUsd });
    const attempts: unknown[] = [];
    const source = new OpenRouterProvider({ apiKey: key, routes, fetch: budget.fetch, estimateInputTokens: estimateBoundedInput, onAttempt: attempt => { attempts.push(safeAttempt(attempt)); } });
    const result = await runConversation({ forTurn: () => source.forTurn(), live: true, directed, rates, budgetReport: budget.report, attempts });
    report = { ...result, configuredRoutes: routes, pricing: { rates }, note: 'Returned responseModel/generation IDs and usage are in budget.attempts; aliases are not proof of an exact model build. Synthetic delivery only, not WhatsApp.' };
    exit = !result.incomplete && !result.stoppedReason && !result.failedTurns ? 0 : 1;
  } catch { /* Never serialize provider exceptions, environment values, headers, or credentials. */ }
  finally {
    try { writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); print('Evaluation report written.'); }
    catch { print('Report write failed; do not rerun automatically.'); exit = 1; }
  }
  return exit;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void main().then(code => { process.exitCode = code; }).catch(() => { console.error('Evaluation failed; no automatic rerun.'); process.exitCode = 1; });
