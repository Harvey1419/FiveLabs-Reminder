import 'dotenv/config';
import { getOrCreateUserByPhone } from '../../src/infrastructure/database/users.js';
import { routeMessage } from '../../src/agent/orchestration/router.js';
import { saveMessage, getRecentMessages } from '../../src/infrastructure/database/messages.js';
import { supabase } from '../../src/infrastructure/database/index.js';
import { getActiveAgentRun } from '../../src/agent/core/agent-run.js';
import { findOrCreateEntityFuzzy } from '../../src/infrastructure/database/entities.js';
import { clearWorkingMemory } from '../../src/agent/core/working-memory.js';
import { clearAgentRunsForUser } from '../../src/infrastructure/database/agent-runs.js';

// ANSI colors
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';

function banner(title) {
  console.log(`\n${BOLD}${CYAN}══════════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}${CYAN}  ${title}${RESET}`);
  console.log(`${BOLD}${CYAN}══════════════════════════════════════════════════════════════${RESET}`);
}

function subBanner(title) {
  console.log(`\n${BOLD}--- ${title} ---${RESET}`);
}

function assert(condition, message) {
  if (!condition) {
    console.error(`  ${RED}✖ FAIL:${RESET} ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ${GREEN}✔ PASS:${RESET} ${message}`);
}

if (process.env.ALLOW_DESTRUCTIVE_BENCHMARK !== 'true') {
  console.error(`\x1b[31m[SAFETY BLOCK] live-convergence-bench deletes user state across database tables.\x1b[0m`);
  console.error('To run this benchmark intentionally, set ALLOW_DESTRUCTIVE_BENCHMARK=true');
  console.error('and configure a designated isolated test user/database.');
  process.exit(1);
}

const TEST_PHONE = '+573009998877';

async function cleanUserState(user) {
  clearWorkingMemory(user);
  clearAgentRunsForUser(user);
  await supabase.from('memories').delete().eq('user_id', user.id);
  await supabase.from('tasks').delete().eq('user_id', user.id);
  await supabase.from('reminders').delete().eq('user_id', user.id);
  await supabase.from('entities').delete().eq('user_id', user.id);
  await supabase.from('agent_runs').delete().eq('user_id', user.id);
  await supabase.from('messages').delete().eq('user_id', user.id);
}

async function runTurn(text, user) {
  const t0 = Date.now();
  await saveMessage({
    userId: user.id,
    phoneNumber: user.phone_number,
    role: 'user',
    content: text,
  });

  const history = await getRecentMessages(user.phone_number, 20);
  console.log(`  ${GRAY}[User] -> "${text}"${RESET}`);

  const result = await routeMessage(text, user, history);
  const elapsed = Date.now() - t0;

  console.log(`  ${GRAY}[Assistant] (${elapsed}ms) -> "${result.confirmation?.replace(/\n/g, ' ')}"${RESET}`);

  await saveMessage({
    userId: user.id,
    phoneNumber: user.phone_number,
    role: 'assistant',
    content: result.confirmation,
    intent: result.intent,
  });

  return { result, elapsed };
}

async function runBenchmark() {
  banner('HERMES ARCHITECTURAL CONVERGENCE — LIVE BENCHMARK');
  console.log(`${GRAY}Targeting live LLM provider & live Supabase PostgreSQL${RESET}\n`);

  const user = await getOrCreateUserByPhone(TEST_PHONE);
  console.log(`Active test user: ${user.phone_number} (ID: ${user.id}, TZ: ${user.timezone})\n`);

  let passedScenarios = 0;
  let totalScenarios = 6;

  // =========================================================================
  // SCENARIO 1: Incomplete Reminder Continuation (Deterministic Delta Merge)
  // =========================================================================
  subBanner('SCENARIO 1: Incomplete Reminder -> Deterministic Continuation');
  try {
    await cleanUserState(user);

    // Turn 1: User asks for a reminder without a time/schedule
    console.log(`\nTurn 1: Requesting reminder with missing time...`);
    const { result: turn1 } = await runTurn('Recuérdame pagar el internet', user);

    const activeRun1 = await getActiveAgentRun(user);
    assert(activeRun1 !== null, 'AgentRun was created in Supabase');
    assert(activeRun1.status === 'waiting_for_input', `AgentRun status is 'waiting_for_input' (got: ${activeRun1?.status})`);
    assert(Boolean(activeRun1.kind), `AgentRun has kind: ${activeRun1?.kind}`);
    const prepared = activeRun1.preparedActions || activeRun1.prepared_actions;
    assert(prepared?.length === 1, 'Prepared action staged in DB');
    assert(prepared[0].action === 'create' || prepared[0].action_type === 'reminder_create', 'Prepared action is reminder create');

    // Turn 2: User provides temporal delta
    console.log(`\nTurn 2: Providing temporal delta to complete the reminder...`);
    const { result: turn2 } = await runTurn('Mañana a las 4 de la tarde', user);

    const activeRun2 = await getActiveAgentRun(user);
    assert(activeRun2 === null, 'Active AgentRun was completed (no active runs remaining)');

    // Verify reminder in DB
    const { data: reminders } = await supabase
      .from('reminders')
      .select('*')
      .eq('user_id', user.id);

    assert(reminders && reminders.length === 1, 'Exactly 1 reminder persisted in Supabase');
    assert(/internet/i.test(reminders[0].content), `Reminder content contains 'internet': "${reminders[0].content}"`);
    assert(Boolean(reminders[0].send_at), `Reminder has resolved send_at timestamp: ${reminders[0].send_at}`);

    passedScenarios += 1;
    console.log(`${GREEN}${BOLD}✔ Scenario 1 Passed!${RESET}`);
  } catch (err) {
    console.error(`${RED}${BOLD}✖ Scenario 1 Failed:${RESET}`, err);
  }

  // =========================================================================
  // SCENARIO 2: Context Switch / Interleaved Turn (Preserving Suspended Run)
  // =========================================================================
  subBanner('SCENARIO 2: Context Switch / Interleaved Turn -> Safe Suspension');
  try {
    await cleanUserState(user);

    // Turn 1: Incomplete reminder
    console.log(`\nTurn 1: Requesting reminder with missing time...`);
    await runTurn('Recuérdame llamar al médico', user);

    const activeRun1 = await getActiveAgentRun(user);
    assert(activeRun1?.status === 'waiting_for_input', 'AgentRun waiting_for_input created');

    // Turn 2: Interleaved unrelated query
    console.log(`\nTurn 2: Switching context with unrelated turn...`);
    const { result: turn2 } = await runTurn('¿Qué proyectos o tareas tengo activas?', user);

    const activeRun2 = await getActiveAgentRun(user);
    assert(activeRun2 !== null, 'AgentRun was NOT cancelled or corrupted by unrelated turn');
    assert(activeRun2.status === 'waiting_for_input', 'AgentRun remained suspended in waiting_for_input');

    // Turn 3: Resume and supply schedule
    console.log(`\nTurn 3: Resuming reminder schedule...`);
    const { result: turn3 } = await runTurn('Ah y lo del médico que sea el próximo lunes a las 10 de la mañana', user);

    const activeRun3 = await getActiveAgentRun(user);
    assert(activeRun3 === null, 'AgentRun completed after continuation');

    const { data: reminders } = await supabase
      .from('reminders')
      .select('*')
      .eq('user_id', user.id);

    assert(reminders && reminders.length === 1, 'Reminder successfully created after resumption');
    assert(/médico|medico/i.test(reminders[0].content), `Reminder content matches medical appointment: "${reminders[0].content}"`);

    passedScenarios += 1;
    console.log(`${GREEN}${BOLD}✔ Scenario 2 Passed!${RESET}`);
  } catch (err) {
    console.error(`${RED}${BOLD}✖ Scenario 2 Failed:${RESET}`, err);
  }

  // =========================================================================
  // SCENARIO 3: Destructive Bulk Approval (Frozen callId execution)
  // =========================================================================
  subBanner('SCENARIO 3: Destructive Bulk Operation -> Frozen Approval');
  try {
    await cleanUserState(user);

    // Seed 3 projects
    const pAlpha = await findOrCreateEntityFuzzy({ userId: user.id, name: 'Proyecto Alfa', category: 'project' });
    const pBeta = await findOrCreateEntityFuzzy({ userId: user.id, name: 'Proyecto Beta', category: 'project' });
    const pPro = await findOrCreateEntityFuzzy({ userId: user.id, name: 'Reminder Pro', category: 'project' });

    console.log(`Seeded entities: Alfa (${pAlpha.id}), Beta (${pBeta.id}), Reminder Pro (${pPro.id})`);

    // Turn 1: Bulk delete request
    console.log(`\nTurn 1: Requesting bulk delete except Reminder Pro...`);
    const { result: turn1 } = await runTurn('Elimina todos los proyectos excepto Reminder Pro', user);

    const activeRun1 = await getActiveAgentRun(user);
    assert(activeRun1 !== null, 'AgentRun created for destructive batch');
    assert(activeRun1.status === 'waiting_for_approval', `Status is 'waiting_for_approval' (got: ${activeRun1?.status})`);
    const prepared = activeRun1.preparedActions || activeRun1.prepared_actions;
    assert(prepared?.length === 2, `2 prepared actions staged for deletion (got: ${prepared?.length})`);

    // Verify entities are NOT deleted yet
    const { data: entitiesBefore } = await supabase.from('entities').select('id, name').eq('user_id', user.id);
    assert(entitiesBefore?.length === 3, 'Entities still intact in DB before confirmation');

    // Turn 2: Confirm deletion
    console.log(`\nTurn 2: Confirming deletion...`);
    const { result: turn2 } = await runTurn('Sí, dale, elimínalos', user);

    const activeRun2 = await getActiveAgentRun(user);
    assert(activeRun2 === null, 'AgentRun completed after approval execution');

    // Verify entities in DB
    const { data: entitiesAfter } = await supabase.from('entities').select('id, name').eq('user_id', user.id);
    assert(entitiesAfter?.length === 1, `Exactly 1 entity remains in DB (got: ${entitiesAfter?.length})`);
    assert(entitiesAfter[0].name.toLowerCase().includes('reminder pro'), `Preserved entity is Reminder Pro (got: ${entitiesAfter[0]?.name})`);

    passedScenarios += 1;
    console.log(`${GREEN}${BOLD}✔ Scenario 3 Passed!${RESET}`);
  } catch (err) {
    console.error(`${RED}${BOLD}✖ Scenario 3 Failed:${RESET}`, err);
  }

  // =========================================================================
  // SCENARIO 4: Explicit Cancellation (Safe Rollback)
  // =========================================================================
  subBanner('SCENARIO 4: Destructive Bulk Operation -> Explicit Cancellation');
  try {
    await cleanUserState(user);

    // Seed 1 project
    const pGamma = await findOrCreateEntityFuzzy({ userId: user.id, name: 'Proyecto Gamma', category: 'project' });
    console.log(`Seeded entity: Gamma (${pGamma.id})`);

    // Turn 1: Delete request
    console.log(`\nTurn 1: Requesting deletion...`);
    await runTurn('Elimina todos los proyectos', user);

    const activeRun1 = await getActiveAgentRun(user);
    assert(activeRun1?.status === 'waiting_for_approval', 'AgentRun waiting_for_approval created');

    // Turn 2: User rejects/cancels
    console.log(`\nTurn 2: Rejecting deletion...`);
    await runTurn('No, mejor no hagas nada, cancela eso', user);

    const activeRun2 = await getActiveAgentRun(user);
    assert(activeRun2 === null, 'No active AgentRun remaining (run was marked rejected)');

    // Verify entity was NOT deleted
    const { data: entitiesAfter } = await supabase.from('entities').select('id, name').eq('user_id', user.id);
    assert(entitiesAfter?.length === 1, 'Proyecto Gamma was preserved in DB');

    passedScenarios += 1;
    console.log(`${GREEN}${BOLD}✔ Scenario 4 Passed!${RESET}`);
  } catch (err) {
    console.error(`${RED}${BOLD}✖ Scenario 4 Failed:${RESET}`, err);
  }

  // =========================================================================
  // SCENARIO 5: Multi-Draft Reminder Batch Continuation (N-ary Execution)
  // =========================================================================
  subBanner('SCENARIO 5: Multi-Draft Reminder Batch Continuation');
  try {
    await cleanUserState(user);

    // Turn 1: 3 reminders without schedule (requires input)
    console.log(`\nTurn 1: Requesting 3 reminders without schedule...`);
    await runTurn('Recuérdame hacer ejercicio, llamar al cliente y enviar reporte', user);

    const activeRun1 = await getActiveAgentRun(user);
    assert(activeRun1 !== null, 'AgentRun created for multi-draft reminders');
    assert(activeRun1.status === 'waiting_for_input', `AgentRun is waiting_for_input (got: ${activeRun1?.status})`);
    const prepared1 = activeRun1.preparedActions || activeRun1.prepared_actions;
    assert(prepared1?.length === 3, `Exactly 3 prepared actions staged (got: ${prepared1?.length})`);

    // Turn 2: Supply schedule "Mañana a las 3 de la tarde"
    console.log(`\nTurn 2: Supplying schedule "Mañana a las 3 de la tarde"...`);
    await runTurn('Mañana a las 3 de la tarde', user);

    const activeRun2 = await getActiveAgentRun(user);
    assert(activeRun2 === null, 'AgentRun completed after batch continuation');

    // Verify all 3 reminders created in Supabase
    const { data: reminders } = await supabase
      .from('reminders')
      .select('*')
      .eq('user_id', user.id)
      .order('send_at', { ascending: true });

    assert(reminders && reminders.length === 3, `All 3 reminders created in DB (got: ${reminders?.length})`);
    console.log(`  Created reminders:`);
    for (const r of (reminders || [])) {
      console.log(`    - ${r.content} @ ${r.send_at}`);
    }

    passedScenarios += 1;
    console.log(`${GREEN}${BOLD}✔ Scenario 5 Passed!${RESET}`);
  } catch (err) {
    console.error(`${RED}${BOLD}✖ Scenario 5 Failed:${RESET}`, err);
  }

  // =========================================================================
  // SCENARIO 6: Actionable Proposal Staging (TIME_IN_PAST -> Proposal Approval)
  // =========================================================================
  subBanner('SCENARIO 6: Past Time Proposal -> One-Click Approval');
  try {
    await cleanUserState(user);

    // Turn 1: Request reminder at an hour already passed today (8:00 AM)
    console.log(`\nTurn 1: Requesting reminder for past time today (8:00 AM)...`);
    const { result: turn1 } = await runTurn('Recuérdame hoy a las 8am tomar vitaminas', user);

    const activeRun1 = await getActiveAgentRun(user);
    assert(activeRun1 !== null, 'AgentRun created for proposal approval');
    assert(activeRun1.status === 'waiting_for_approval', `AgentRun is waiting_for_approval (got: ${activeRun1?.status})`);
    assert(activeRun1.kind === 'proposal_approval', `AgentRun kind is proposal_approval (got: ${activeRun1?.kind})`);

    // Turn 2: Approve proposal with "dale"
    console.log(`\nTurn 2: Confirming proposal with "dale"...`);
    const { result: turn2 } = await runTurn('dale', user);

    const activeRun2 = await getActiveAgentRun(user);
    assert(activeRun2 === null, 'AgentRun completed after proposal approval');

    // Verify reminder created in DB for tomorrow
    const { data: reminders } = await supabase
      .from('reminders')
      .select('*')
      .eq('user_id', user.id);

    assert(reminders && reminders.length === 1, `Exactly 1 reminder created (got: ${reminders?.length})`);
    assert(/vitaminas/i.test(reminders[0]?.content), `Reminder content matches vitaminas: "${reminders[0]?.content}"`);
    console.log(`  Approved reminder created @ ${reminders[0]?.send_at}`);

    passedScenarios += 1;
    console.log(`${GREEN}${BOLD}✔ Scenario 6 Passed!${RESET}`);
  } catch (err) {
    console.error(`${RED}${BOLD}✖ Scenario 6 Failed:${RESET}`, err);
  }

  // Final Cleanup
  await cleanUserState(user);

  banner('BENCHMARK SUMMARY');
  console.log(`Results: ${passedScenarios}/${totalScenarios} Scenarios Passed`);
  if (passedScenarios === totalScenarios) {
    console.log(`${GREEN}${BOLD}ALL CONVERGENCE SCENARIOS PASSED WITH REAL LLM & REAL POSTGRES! 🚀${RESET}\n`);
  } else {
    console.log(`${RED}${BOLD}SOME SCENARIOS FAILED. CHECK LOGS ABOVE.${RESET}\n`);
    process.exit(1);
  }
}

runBenchmark().catch((err) => {
  console.error('Benchmark crashed:', err);
  process.exit(1);
});
