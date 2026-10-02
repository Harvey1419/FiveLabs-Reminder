import 'dotenv/config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('../../', import.meta.url).href;
const reportPath = process.env.HERMES_SEMANTIC_REPORT_PATH || join(tmpdir(), 'hermes-semantic-boundaries.json');
const fetchReal = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.origin, 'https://openrouter.ai', 'This evaluation cannot access production databases or delivery services');
  return fetchReal(input, options);
};
const { compileDispatchPolicy } = await import(root + 'src/features/reminders/dispatch-policy.js');
const { validateMemoryCandidates } = await import(root + 'src/features/memory/validate-candidates.js');
const { buildAgentCorePrompt } = await import(root + 'src/agent/core/agent-core.js');
const { getStructuredTurnSchema, projectStructuredTurnIntent, stripStructuredNulls } = await import(root + 'src/agent/contracts/foreground-turn-schema.js');
const { validateTurnIntent } = await import(root + 'src/agent/contracts/intent-contracts.js');
const { answerFromObservedReads } = await import(root + 'src/agent/orchestration/observed-answer.js');
const { callChatCompletion } = await import(root + 'src/agent/providers/client.js');
const results = [];
async function test(name, fn) {
  const start = Date.now();
  try { results.push({ name, passed: true, evidence: await fn(), latencyMs: Date.now() - start }); }
  catch (error) { results.push({ name, passed: false, error: error.message, latencyMs: Date.now() - start }); }
  console.log(JSON.stringify(results.at(-1)));
  writeFileSync(reportPath, JSON.stringify(results, null, 2));
}
const policyCases = [
  ['unrelated_preference', ['Prefiero café sin azúcar'], p => { assert.deepEqual(p.explicit.global, {}); assert.deepEqual(p.explicit.recurring, {}); }],
  ['spanish_scope_exception', ['Insiste cada veinte minutos hasta que responda, excepto con las rutinas: para ellas basta el aviso inicial y no quiero botones.'], p => { assert.equal(p.global.requiresConfirmation, true); assert.equal(p.global.nudgeIntervalMinutes, 20); assert.equal(p.recurring.disableNudges, true); assert.equal(p.recurring.disableButtons, true); }],
  ['english_negation', ["I do not want you to stop following up on my reminders. Keep asking every half hour until I acknowledge them."], p => { assert.equal(p.global.requiresConfirmation, true); assert.equal(p.global.nudgeIntervalMinutes, 30); assert.equal(p.global.disableNudges, false); }],
  ['newer_correction', ['No me muestres botones en los recordatorios.', 'Ahora sí quiero botones en todos mis recordatorios.'], p => { assert.equal(p.global.disableButtons, false); assert.equal(p.recurring.disableButtons, false); }],
];
for (const [name, texts, check] of policyCases) await test(name, async () => {
  const policy = await compileDispatchPolicy({ userId: 'read-only-' + name, preferences: texts.map((content, index) => ({ id: String(index), content, created_at: `2026-10-0${index + 1}` })) }); check(policy); return policy;
});
const memoryCases = [
  ['ephemeral_intent', 'Quiero ir hoy al turco en el gym', [{ content: 'Al usuario le gusta ir al turco del gimnasio.', evidence: 'Quiero ir hoy al turco en el gym' }], 0],
  ['explicit_habit', 'Me encanta ir al turco del gimnasio y suelo hacerlo todos los viernes.', [{ content: 'Al usuario le gusta ir al turco del gimnasio los viernes.', evidence: 'Me encanta ir al turco del gimnasio y suelo hacerlo todos los viernes.' }], 1],
  ['project_operation', 'Crea un proyecto llamado QA-HERMES-A', [{ content: 'El usuario tiene un proyecto llamado QA-HERMES-A.', evidence: 'Crea un proyecto llamado QA-HERMES-A' }], 0],
  ['shared_words_durable_fact', 'Mi hermana Laura es mi contadora; recuérdame llamar a Laura mañana.', [{ content: 'Laura es la hermana y contadora del usuario.', evidence: 'Mi hermana Laura es mi contadora' }, { content: 'El usuario llamará a Laura mañana.', evidence: 'recuérdame llamar a Laura mañana' }], 1],
  ['fact_inside_question', '¿Recuerdas que vivo en Cali desde 2020?', [{ content: 'El usuario vive en Cali desde 2020.', evidence: 'vivo en Cali desde 2020' }], 1],
];
for (const [name, userText, candidates, count] of memoryCases) await test(name, async () => {
  const admitted = await validateMemoryCandidates({ userText, candidates, executionFacts: [{ tool: 'manage_reminder', success: true }] });
  assert.equal(admitted.length, count); if (count) assert.equal(admitted[0].content, candidates[0].content); return admitted;
});
for (const [text, domain] of [['Muéstrame mi agenda del 14 de enero de 2031', 'agenda'], ['Show only my Google Calendar events for January 14, 2031', 'calendar']]) await test('routing_' + domain, async () => {
  const prompt = buildAgentCorePrompt({ nowStr: '2026-10-02T14:00:00-05:00', nowHumanStr: 'viernes 2 de octubre de 2026, 14:00', timezone: 'America/Bogota', language: 'es', isPro: true, googleIntegration: { present: true } });
  const schema = getStructuredTurnSchema();
  const result = await callChatCompletion([{ role: 'system', content: prompt }, { role: 'user', content: text }], { purpose: 'initial', tools: null, toolChoice: 'none', returnMessage: true, max_tokens: 3000, responseFormat: { type: 'json_schema', json_schema: { name: 'hermes_live_intent', strict: true, schema } }, validateStructuredContent: content => { try { return validateTurnIntent(projectStructuredTurnIntent(stripStructuredNulls(JSON.parse(content)))); } catch { return { valid: false }; } } });
  assert.ok(!result.unavailable); const intent = projectStructuredTurnIntent(stripStructuredNulls(JSON.parse(result.content))); assert.equal(intent.actions[0].domain, domain); assert.equal(intent.responseLanguage, domain === 'calendar' ? 'en' : 'es'); return intent;
});
await test('inventory_no_duplicate', async () => {
  const answer = await answerFromObservedReads({ userText: 'Muéstrame las tareas de QA', language: 'es', facts: [{ success: true, complete: true, callId: 'r1', requestedAction: 'list', presentationData: { entityName: 'QA', tasks: [{ id: 't1', title: 'Preparar propuesta', entityName: 'QA' }] } }] });
  assert.equal(answer, null); return { answer };
});
console.log(JSON.stringify({ passed: results.filter(r => r.passed).length, total: results.length }));
console.log(`Report: ${reportPath}`);
process.exitCode = results.every(r => r.passed) ? 0 : 1;
