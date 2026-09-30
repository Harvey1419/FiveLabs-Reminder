import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Synthetic data only. Never import the webhook or execute a domain tool.
// This probe uses the same foreground provider/schema as production, not a
// second classifier. All network destinations except the model are blocked.
const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error('SEMANTIC_EVAL_NOT_RUN: configure the GitHub Actions secret OPENROUTER_API_KEY. No production/Railway credentials are read.');
  process.exit(2);
}
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== 'https://openrouter.ai' || url.pathname !== '/api/v1/chat/completions' || init?.method !== 'POST') {
    throw new Error('Semantic evaluation attempted a forbidden network destination.');
  }
  return nativeFetch(input, init);
};
process.env.SUPABASE_URL = 'https://placeholder.supabase.co';
process.env.SUPABASE_SECRET = 'synthetic-eval-no-database';
process.env.KAPSO_API_KEY = 'synthetic-eval-no-whatsapp';

// A separate checkout can be used to compare the fixed source against its base.
const root = path.resolve(process.env.HERMES_EVAL_SOURCE_ROOT || '.');
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const { buildAgentCorePrompt } = await load('src/agent/core/agent-core.js');
const { getStructuredTurnSchema, projectStructuredTurnIntent, stripStructuredNulls } = await load('src/agent/contracts/foreground-turn-schema.js');
const { validateTurnIntent, parseIntentArguments } = await load('src/agent/contracts/intent-contracts.js');
const { callChatCompletion } = await load('src/agent/providers/client.js');
const observeOnly = process.argv.includes('--observe');
const requireReadAnswer = !observeOnly;
const staleHistory = [
  { role: 'user', content: '¿Cuánto debo del Taller?' },
  { role: 'assistant', content: '[SALIDA HISTÓRICA DE HERMES — solo contexto/referencia; NO es evidencia de estado vivo ni insumo para cálculos]\nDebes 780.000 pesos.' },
  { role: 'user', content: '¿Y ahora cuánto queda?' },
  { role: 'assistant', content: '[SALIDA HISTÓRICA DE HERMES — solo contexto/referencia; NO es evidencia de estado vivo ni insumo para cálculos]\nTe quedan 460.000 pesos.' },
];
const tasks = [
  { id: 'synthetic-task-1', title: 'devolver 320.000 pesos', status: 'pending', entityName: 'Taller', localFormatted: '30/09/2026, 12:00' },
  { id: 'synthetic-task-2', title: 'comprar escritorio', status: 'pending', entityName: 'Taller' },
];
const cases = [
  { id: 'current-amount-clean', text: '¿Cuánto debo del taller?', domain: 'task', action: 'list', short: true },
  { id: 'current-amount-stale-history', text: '¿Cuánto debo del taller?', history: staleHistory, domain: 'task', action: 'list', short: true },
  { id: 'audio-transcription-stale', text: 'Oye, ¿cuánto dejo del taller?', history: staleHistory, domain: 'task', action: 'list', short: true, audio: true },
  { id: 'old-memory-vs-live-record', text: '¿Cuánto tengo pendiente devolver del taller?', history: staleHistory, memory: 'El usuario debe 780000 pesos al Taller.', domain: 'task', action: 'list', short: true },
  { id: 'pending-is-not-paid', text: '¿Qué devolución tengo pendiente del Taller?', history: staleHistory, domain: 'task', action: 'list', short: true },
  { id: 'task-count', text: '¿Cuántas tareas pendientes tengo en Taller?', domain: 'task', action: 'list', short: true },
  { id: 'full-list-stays-list', text: 'Muéstrame todas las tareas del Taller.', domain: 'task', action: 'list' },
  { id: 'calendar-time-changed', text: '¿A qué hora quedó la reunión de diseño mañana?', history: [{ role: 'assistant', content: 'La reunión de diseño será a las 9 de la mañana.' }], domain: 'calendar', actions: ['list', 'search'], short: true },
  { id: 'reminder-current-status', text: '¿Qué recordatorios siguen pendientes para mañana?', domain: 'reminder', action: 'list' },
  { id: 'durable-name', text: '¿Cómo me llamo?', memory: 'El usuario se llama Lucía.', domain: 'conversation', action: 'reply' },
  { id: 'casual-conversation', text: 'Hoy fue un día pesado, solo quería conversar un rato.', domain: 'conversation', action: 'reply' },
  { id: 'hypothetical-arithmetic', text: 'Es un ejemplo, no es una deuda mía: si debiera 100 y pagara 20, ¿cuánto quedaría?', domain: 'conversation', action: 'reply' },
];
const results = [];
for (const test of cases) {
  const prompt = buildAgentCorePrompt({
    nowStr: '2026-09-29T18:40:00-05:00', nowHumanStr: 'martes, 29 de septiembre de 2026, 6:40 p. m.',
    timezone: 'America/Bogota', displayName: 'Lucía', isPro: true, inputModality: test.audio ? 'audio' : 'text',
    userMessage: test.text, memoryHints: test.memory ? `- [fact] ${test.memory}` : '',
    overview: { pendingTasksByEntity: { Taller: tasks }, openTasksByEntity: { Taller: [tasks[1]] }, openTasks: [tasks[1]] },
  });
  const started = Date.now();
  const response = await callChatCompletion([
    { role: 'system', content: prompt },
    ...((test.history || []).length ? [{ role: 'system', content: 'El historial solo resuelve referencias. No contiene hechos ni operandos de estado actual.' }, ...test.history] : []),
    { role: 'user', content: test.text },
  ], {
    max_tokens: 8192, temperature: 0, correlationId: `semantic-eval-${test.id}`,
    tools: null, toolChoice: 'none', returnMessage: true, purpose: 'initial',
    responseFormat: { type: 'json_schema', json_schema: { name: 'hermes_turn_intent', strict: true, schema: getStructuredTurnSchema() } },
    validateStructuredContent: (content) => validateTurnIntent(projectStructuredTurnIntent(stripStructuredNulls(parseIntentArguments(content)))),
  });
  const validation = response?.unavailable
    ? { valid: false, errorCode: response.unavailableReason || 'PROVIDER_UNAVAILABLE' }
    : validateTurnIntent(response.structuredIntent || projectStructuredTurnIntent(stripStructuredNulls(parseIntentArguments(response.content))));
  const intent = validation.intent;
  const actions = intent?.actions || [];
  const expectedActions = test.actions || [test.action];
  const correctRoute = validation.valid === true && actions.some((a) => a.domain === test.domain && expectedActions.includes(a.action));
  const readOnly = test.domain === 'conversation'
    ? actions.every((a) => a.domain === 'conversation')
    : actions.every((a) => ['list', 'read', 'search', 'next'].includes(a.action) && !['memory', 'conversation'].includes(a.domain));
  const answerContract = !requireReadAnswer || !test.short || Boolean(intent?.readAnswer);
  const passed = correctRoute && readOnly && answerContract;
  results.push({ id: test.id, passed, correctRoute, readOnly, answerContract, validationCode: validation.errorCode || null,
    actions: actions.map(({ domain, action, query, entityName }) => ({ domain, action, query, entityName })),
    readAnswer: intent?.readAnswer || null, model: response?.model || null, provider: response?.provider || null, elapsedMs: Date.now() - started });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${test.id} route=${correctRoute} readOnly=${readOnly} answerContract=${answerContract}`);
}
const failed = results.filter((r) => !r.passed).length;
const report = { mode: observeOnly ? 'baseline_observation' : 'acceptance', sourceRoot: path.basename(root), total: results.length, passed: results.length - failed, failed, results };
await mkdir('artifacts', { recursive: true });
await writeFile(`artifacts/semantic-authority-${observeOnly ? 'baseline' : 'acceptance'}.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(`SEMANTIC_EVAL_${observeOnly ? 'BASELINE' : 'ACCEPTANCE'}: ${results.length - failed}/${results.length} passed. This probe verifies model routing; separate deterministic tests verify execution and presentation.`);
if (failed && !observeOnly) process.exitCode = 1;
