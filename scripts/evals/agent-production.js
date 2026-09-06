import 'dotenv/config';
import { buildAgentCorePrompt } from '../../src/agent/core/agent-core.js';
import {
  callChatCompletion,
  callManifestCoverageVerification,
  callPendingTransitionVerification,
} from '../../src/agent/providers/client.js';
import { getAgentToolDefinitions, parseToolArguments, validateToolCall } from '../../src/agent/contracts/tool-contracts.js';
import { compileTurnManifest } from '../../src/agent/orchestration/turn-plan.js';
import {
  MANIFEST_REPAIR_MODE,
  buildManifestRecoveryFeedback,
  getManifestRepairDirective,
} from '../../src/agent/orchestration/manifest-recovery.js';
import { formatAssistantClarification } from '../../src/agent/orchestration/clarification-presentation.js';
import { nowISO, nowHuman } from '../../src/shared/time.js';

const tools = getAgentToolDefinitions({ isAdmin: false });
const results = [];
const conversationsOnly = process.env.AGENT_EVAL_SCOPE === 'conversations';
const conversationFilter = process.env.AGENT_EVAL_CONVERSATION || null;
const scenarioFilter = process.env.AGENT_EVAL_SCENARIO || null;

function promptFor({
  referenceTime,
  timezone,
  workingMemoryText = '',
  memoryHints = '',
  overview = null,
  googleIntegration = null,
  displayName = 'Lamparín',
}) {
  return buildAgentCorePrompt({
    nowStr: nowISO(timezone, referenceTime),
    nowHumanStr: nowHuman(timezone, 'es', referenceTime),
    timezone,
    memoryHints,
    overview,
    workingMemoryText,
    googleIntegration,
    isAdmin: false,
    isPro: true,
    displayName,
  });
}

async function requestPlanWithRepair({
  messages,
  purpose,
  correlationId,
  toolChoice,
  userMessage,
  referenceTime,
  timezone,
  workingMemory,
  workingMemoryText = '',
  recentConversation = [],
}) {
  let agentMessages = messages.slice();
  let repairDirective = null;
  let lastCoverage = null;
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response = await callChatCompletion(agentMessages, {
      tools,
      toolChoice: attempt === 0
        ? toolChoice
        : repairDirective?.mode === MANIFEST_REPAIR_MODE.REQUIRED
          ? 'required'
          : 'auto',
      returnMessage: true,
      purpose: attempt === 0 ? purpose : `${purpose}_manifest_repair`,
      max_tokens: attempt === 0 ? 2000 : 2400,
      correlationId: attempt === 0 ? correlationId : `${correlationId}-repair`,
    });
    const call = response?.tool_calls?.find((item) => item.function?.name === 'execute_turn');
    const params = call ? parseToolArguments(call.function.arguments) : null;
    const validation = params
      ? validateToolCall({ toolName: 'execute_turn', params })
      : { valid: false, errorCode: 'MISSING_EXECUTE_TURN', error: 'missing execute_turn' };
    const compiled = validation.valid
      ? compileTurnManifest(validation.params, { userMessage, referenceTime, timezone, workingMemory })
      : validation;
    repairDirective = call ? getManifestRepairDirective(validation, compiled) : null;
    let recoveryFeedback = repairDirective
      ? buildManifestRecoveryFeedback({ directive: repairDirective, language: 'es' })
      : null;
    if (!repairDirective && call && validation.valid && compiled.valid) {
      const coverage = await callManifestCoverageVerification({
        userText: userMessage,
        manifest: validation.params,
        conversationState: workingMemoryText,
        recentConversation,
        currentTime: nowISO(timezone, referenceTime),
        correlationId: `${correlationId}-coverage`,
      });
      lastCoverage = coverage;
      if (coverage?.verdict === 'incomplete' && coverage.confidence === 'high') {
        repairDirective = {
          mode: MANIFEST_REPAIR_MODE.REQUIRED,
          errorCode: 'INCOMPLETE_TURN_COVERAGE',
        };
        recoveryFeedback = {
          outcome: 'manifest_incomplete_before_execution',
          missingQuote: coverage.missingQuote,
          instruction: `No se ejecutó nada. La cláusula “${coverage.missingQuote}” no está contemplada. Agrega la operación autorizada o inclúyela en excludedClauses con el motivo correcto. ${coverage.feedback}`,
        };
      }
    }
    if (!repairDirective && !call) {
      const coverage = await callManifestCoverageVerification({
        userText: userMessage,
        manifest: { operations: [], excludedClauses: [] },
        conversationState: workingMemoryText,
        recentConversation,
        currentTime: nowISO(timezone, referenceTime),
        assistantResponse: response?.content || '',
        correlationId: `${correlationId}-coverage`,
      });
      lastCoverage = coverage;
      if (
        coverage?.verdict === 'complete'
        && coverage.clarificationConfidence === 'high'
        && coverage.assistantClarification
      ) {
        const clarification = formatAssistantClarification(coverage.assistantClarification, 'es');
        if (clarification) response = { ...response, content: clarification };
      }
      if (coverage?.verdict === 'incomplete' && coverage.confidence === 'high') {
        repairDirective = {
          mode: MANIFEST_REPAIR_MODE.REQUIRED,
          errorCode: 'MISSING_EXECUTE_TURN',
        };
        recoveryFeedback = {
          outcome: 'action_omitted_from_prose_response',
          missingQuote: coverage.missingQuote,
          instruction: `No se ejecutó nada. La cláusula “${coverage.missingQuote}” requiere una operación dentro del alcance. Devuelve un execute_turn completo con sourceQuote literal. ${coverage.feedback}`,
        };
      }
    }
    if (!repairDirective || attempt === maxAttempts - 1) {
      return { response, call, params, validation, compiled, repairAttempts: attempt, coverage: lastCoverage };
    }

    agentMessages = call
      ? [
        ...agentMessages,
        { role: 'assistant', content: response?.content || null, tool_calls: response.tool_calls },
        {
          role: 'tool',
          tool_call_id: call.id,
          name: 'execute_turn',
          content: JSON.stringify(recoveryFeedback),
        },
      ]
      : [
        ...agentMessages,
        { role: 'assistant', content: response?.content || 'Entendido.' },
        { role: 'system', content: recoveryFeedback.instruction },
      ];
  }
  throw new Error('unreachable manifest repair loop');
}

async function planScenario({ name, message, referenceTime, timezone, workingMemory = { items: [] }, workingMemoryText = '', assert }) {
  if (conversationsOnly || (scenarioFilter && scenarioFilter !== name)) return { skipped: true };
  const planned = await requestPlanWithRepair({
    messages: [
    { role: 'system', content: promptFor({ referenceTime, timezone, workingMemoryText }) },
    { role: 'user', content: message },
    ],
    toolChoice: 'required',
    purpose: `production_eval_${name}`,
    correlationId: `eval-${name}`,
    userMessage: message,
    referenceTime,
    timezone,
    workingMemory,
    workingMemoryText,
  });
  const { response, params, validation, compiled, repairAttempts, coverage } = planned;
  const checks = assert({ response, params, validation, compiled, coverage });
  const failures = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
  results.push({
    name,
    passed: failures.length === 0,
    failures,
    finishReason: response?.finishReason || null,
    kinds: params?.operations?.map((op) => op.kind) || [],
    schedules: params?.operations?.map((op) => op.schedule?.kind || null) || [],
    compiled: compiled?.entries?.map((entry) => ({ kind: entry.operation?.kind, valid: entry.valid, errorCode: entry.errorCode, targetTime: entry.params?.items?.[0]?.targetTime })) || [],
    repairAttempts,
    ...(failures.length > 0 ? { operations: params?.operations || [], coverage } : {}),
  });
  return { response, params, validation, compiled };
}

function normalized(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function hasText(value, expected) {
  return normalized(value).includes(normalized(expected));
}

async function runConversation({
  name,
  referenceTime,
  timezone,
  googleIntegration = null,
  memoryHints = '',
  turns,
}) {
  if (scenarioFilter) return;
  if (conversationFilter && conversationFilter !== name) return;
  const history = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const planned = await requestPlanWithRepair({
      messages: [
      {
        role: 'system',
        content: promptFor({
          referenceTime: turn.referenceTime || referenceTime,
          timezone,
          workingMemoryText: turn.workingMemoryText || '',
          memoryHints: turn.memoryHints ?? memoryHints,
          overview: turn.overview || null,
          googleIntegration,
        }),
      },
      ...history,
      { role: 'user', content: turn.message },
      ],
      toolChoice: turn.hasPendingState ? 'required' : 'auto',
      purpose: `conversation_eval_${name}_${index + 1}`,
      correlationId: `conversation-eval-${name}-${index + 1}`,
      userMessage: turn.message,
      referenceTime: turn.referenceTime || referenceTime,
      timezone,
      workingMemory: turn.workingMemory || { items: [] },
      workingMemoryText: turn.workingMemoryText || '',
      recentConversation: history,
    });
    const { response, call, params, validation, compiled, repairAttempts, coverage } = planned;
    const checks = turn.assert({ response, call, params, validation, compiled, history, coverage });
    const failures = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
    results.push({
      name: `conversation_${name}_turn_${index + 1}`,
      conversation: name,
      turn: index + 1,
      passed: failures.length === 0,
      failures,
      finishReason: response?.finishReason || null,
      kinds: params?.operations?.map((operation) => operation.kind) || [],
      schedules: params?.operations?.map((operation) => operation.schedule?.kind || null) || [],
      compiled: compiled?.entries?.map((entry) => ({
        kind: entry.operation?.kind,
        valid: entry.valid,
        errorCode: entry.errorCode,
        toolName: entry.toolName,
      })) || [],
      repairAttempts,
      ...(failures.length > 0 ? {
        operations: params?.operations || [],
        excludedClauses: params?.excludedClauses || [],
        modelContent: response?.content || '',
        coverage,
      } : {}),
    });

    history.push({ role: 'user', content: turn.message });
    const assistantContent = turn.assistantReply
      || response?.content
      || (call ? 'Listo, procesé lo que me pediste.' : 'Entendido.');
    history.push({ role: 'assistant', content: assistantContent });
  }
}

const bogotaReference = new Date('2026-09-05T03:20:00.000Z');
await planScenario({
  name: 'compound_8_operations',
  referenceTime: bogotaReference,
  timezone: 'America/Bogota',
  message: 'Necesito que hagas todo esto en este orden: 1) recuérdame llamar a Laura en 10 minutos; 2) recuérdame enviar el informe mañana a las 9 de la mañana; 3) crea la tarea preparar demo en el proyecto Trabajo; 4) crea el proyecto Casa; 5) crea el proyecto Salud; 6) dime las tareas pendientes del proyecto Trabajo; 7) elimina la tarea Presupuesto viejo; y 8) cancela el recordatorio Tomar agua. No programes nada de esta frase: si algún día viajo, recuérdame comprar maleta.',
  assert: ({ params, validation, compiled }) => ({
    schema_valid: validation.valid,
    compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
    all_entries_valid: compiled.entries?.every((entry) => entry.valid),
    eight_operations: params?.operations?.length === 8,
    complete_kinds: ['reminder_create','task_create','task_list','task_delete','reminder_cancel'].every((kind) => params?.operations?.some((op) => op.kind === kind)) && params?.operations?.filter((op) => ['entity_create','entity_upsert'].includes(op.kind)).length === 2 && params?.operations?.filter((op) => op.kind === 'reminder_create').length === 2,
    hypothetical_not_executed: !params?.operations?.some((op) => JSON.stringify(op).toLocaleLowerCase().includes('comprar maleta')),
  }),
});

await planScenario({
  name: 'bogota_mixed_past_and_relative',
  referenceTime: bogotaReference,
  timezone: 'America/Bogota',
  message: 'Recuérdame alimentar a Borona hoy a las 4 de la tarde, llevar a mi amorcito en 10 minutos y decirle que la amo en 20 minutos.',
  assert: ({ params, validation, compiled }) => ({
    schema_valid: validation.valid,
    compilation_valid: compiled.valid,
    three_operations: params?.operations?.length === 3,
    typed_semantics: ['relative_day_time', 'local_time'].includes(params?.operations?.[0]?.schedule?.kind)
      && JSON.stringify(params?.operations?.slice(1).map((op) => op.schedule?.kind)) === JSON.stringify(['relative_offset','relative_offset']),
    first_is_past_today: Date.parse(compiled.entries?.[0]?.params?.items?.[0]?.targetTime) < bogotaReference.getTime(),
    relatives_future: compiled.entries?.slice(1).every((entry) => Date.parse(entry.params?.items?.[0]?.targetTime) > bogotaReference.getTime()),
  }),
});

await planScenario({
  name: 'same_turn_appointment_advance',
  referenceTime: new Date('2026-09-05T15:41:14.000Z'),
  timezone: 'America/Bogota',
  message: 'Recuérdame de llevar a mi amorcito en 10 minutos. Recuérdame que tengo que decirle que la amo mucho en 20 minutos. A las 4 de la tarde tenemos cita con Borona en el veterinario para que le tomen radiografías. Avísame media hora antes que tengo esa cita, por favor.',
  assert: ({ params, validation, compiled }) => ({
    schema_valid: validation.valid,
    compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
    three_reminder_intents: params?.operations?.filter((operation) => operation.kind === 'reminder_create').length === 3,
    one_backend_batch: compiled.entries?.length === 1 && compiled.entries?.[0]?.params?.items?.length === 3,
    advance_attached_to_appointment: compiled.entries?.[0]?.params?.items?.[2]?.advanceMinutes === 30,
    no_unresolved_advance: !compiled.entries?.some((entry) => entry.operation?.kind === 'reminder_add_advance'),
  }),
});

for (const scenario of [
  { name: 'madrid_dst_gap', timezone: 'Europe/Madrid', referenceTime: new Date('2026-03-28T12:00:00.000Z') },
  { name: 'new_york_dst_gap', timezone: 'America/New_York', referenceTime: new Date('2026-03-07T17:00:00.000Z') },
]) {
  await planScenario({
    ...scenario,
    message: 'Recuérdame mañana a las 2:30 de la madrugada revisar el servidor y mañana a las 3:30 de la madrugada llamar al equipo.',
    assert: ({ params, validation, compiled }) => ({
      schema_valid: validation.valid,
      compilation_valid: compiled.valid,
      two_operations: params?.operations?.length === 2,
      relative_calendar_days: params?.operations?.every((op) => op.schedule?.kind === 'relative_day_time' && op.schedule?.dayOffset === 1),
      gap_rejected: compiled.entries?.[0]?.errorCode === 'INVALID_LOCAL_TIME',
      post_gap_valid: compiled.entries?.[1]?.valid === true,
    }),
  });
}

await planScenario({
  name: 'tokyo_explicit_date_reminder',
  referenceTime: new Date('2026-09-05T00:00:00.000Z'),
  timezone: 'Asia/Tokyo',
  message: 'Recuérdame el 6 de septiembre de 2026 a las 10 de la mañana llamar a Tokio.',
  assert: ({ params, validation, compiled }) => ({
    schema_valid: validation.valid,
    compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
    reminder_domain: params?.operations?.length === 1 && params.operations[0]?.kind === 'reminder_create',
    local_clock_to_utc: compiled.entries?.[0]?.params?.items?.[0]?.targetTime === '2026-09-06T01:00:00.000Z',
  }),
});

const pending = [{
  type: 'reminder',
  content: 'Cita con Borona en el veterinario',
  question: '¿Quieres que lo programe mañana a las 4:00 p. m.?',
  proposedReminder: {
    content: 'Cita con Borona en el veterinario',
    targetTime: '2026-09-05T21:00:00.000Z',
    sourceTimeText: 'hoy a las 4 de la tarde',
  },
}];
const pendingText = '[Typed Pending State — estas propuestas NO han sido ejecutadas]\n1. contextRef={source:pending_state,position:1} | status=NOT_EXECUTED | Cita con Borona en el veterinario | proposedAt: 2026-09-05T21:00:00.000Z | Pregunta pendiente: ¿Quieres que lo programe mañana a las 4:00 p. m.?\nToda respuesta actual sobre este estado debe usar execute_pending, discard_pending, revise_pending o clarification_request.';

for (const pendingCase of [
  { name: 'pending_yes', message: 'Sí, por favor.', expected: 'execute_pending' },
  { name: 'pending_negative_ambiguous_phrase', message: 'No, mejor déjalo así.', expected: 'discard_pending' },
  { name: 'pending_revise', message: 'Sí, pero mejor mañana a las 5:30.', expected: 'revise_pending', schedule: 'relative_day_time' },
]) {
  const planned = await planScenario({
    name: pendingCase.name,
    message: pendingCase.message,
    referenceTime: bogotaReference,
    timezone: 'America/Bogota',
    workingMemory: { scope: 'clarification', pendingClarifications: pending, items: [] },
    workingMemoryText: pendingText,
    assert: ({ params, validation, compiled }) => ({
      schema_valid: validation.valid,
      compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
      expected_transition: params?.operations?.[0]?.kind === pendingCase.expected,
      one_pending_transition: params?.operations?.length === 1,
      typed_pending_reference: !params?.operations?.[0]?.contextRef
        || (params.operations[0].contextRef.source === 'pending_state' && params.operations[0].contextRef.position === 1),
      schedule_if_revised: !pendingCase.schedule || params?.operations?.[0]?.schedule?.kind === pendingCase.schedule,
    }),
  });
  const proposal = planned.params?.operations?.[0];
  if (planned.skipped) continue;
  const verification = await callPendingTransitionVerification({
    userText: pendingCase.message,
    pendingState: { count: 1, selectedPosition: 1, selected: { content: pending[0].content, question: pending[0].question, proposedAt: pending[0].proposedReminder.targetTime, status: 'not_executed' } },
    proposedOperation: proposal
      ? { kind: proposal.kind, schedule: proposal.schedule || null }
      : { kind: 'no_tool_response' },
    correlationId: `eval-verifier-${pendingCase.name}`,
  });
  const result = results.find((item) => item.name === pendingCase.name);
  result.verifier = verification;
  const recoveredWithoutPlanner = ['execute_pending', 'discard_pending'].includes(pendingCase.expected)
    && planned.validation?.errorCode === 'MISSING_EXECUTE_TURN'
    && verification?.transition === pendingCase.expected
    && verification?.confidence === 'high';
  if (recoveredWithoutPlanner) {
    // Mirrors production: a high-confidence verifier may resolve one existing
    // typed proposal directly when the planner omitted execute_turn. The
    // verifier cannot create a new domain operation or directly revise it.
    result.passed = true;
    result.failures = [];
    result.recoveryPath = 'single_typed_pending_verifier';
  }
  if (verification?.transition !== pendingCase.expected || verification?.confidence === 'low') {
    result.passed = false;
    result.failures.push('verifier_transition');
  }
}

await planScenario({
  name: 'advance_continuity_second_item',
  referenceTime: bogotaReference,
  timezone: 'America/Bogota',
  message: 'Al segundo avísame 10 minutos antes.',
  workingMemory: {
    items: [
      { position: 1, type: 'reminder', title: 'Cita médica', time: '2026-09-06T15:00:00.000Z' },
      { position: 2, type: 'reminder', title: 'Llamada con Ana', time: '2026-09-06T16:00:00.000Z' },
    ],
  },
  workingMemoryText: '1. contextRef={source:working_memory,position:1} | [Recordatorio] Cita médica\n2. contextRef={source:working_memory,position:2} | [Recordatorio] Llamada con Ana',
  assert: ({ params, validation, compiled }) => ({
    schema_valid: validation.valid,
    compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
    add_advance: params?.operations?.[0]?.kind === 'reminder_add_advance',
    second_reference: params?.operations?.[0]?.contextRef?.position === 2,
    ten_minutes: params?.operations?.[0]?.advanceMinutes === 10,
    compiled_update: compiled.entries?.[0]?.params?.action === 'update' && compiled.entries?.[0]?.params?.target === '2',
  }),
});

await planScenario({
  name: 'active_projects_are_task_work',
  referenceTime: bogotaReference,
  timezone: 'America/Bogota',
  message: '¿En qué proyectos estoy trabajando ahora y qué tareas tengo pendientes en cada uno?',
  assert: ({ params, validation, compiled }) => ({
    schema_valid: validation.valid,
    compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
    reads_pending_work: params?.operations?.length === 1 && params.operations[0].kind === 'task_list',
    no_entity_catalog: !params?.operations?.some((operation) => operation.kind === 'entity_list'),
  }),
});

await planScenario({
  name: 'project_catalog_excludes_other_entities',
  referenceTime: bogotaReference,
  timezone: 'America/Bogota',
  message: 'Muéstrame solamente mis proyectos. No incluyas empresas, personas ni otros tipos.',
  assert: ({ params, validation, compiled }) => ({
    schema_valid: validation.valid,
    compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
    project_inventory: params?.operations?.length === 1
      && params.operations[0].kind === 'entity_list'
      && params.operations[0].category === 'project',
  }),
});

await planScenario({
  name: 'complete_task_and_stage_project_cleanup',
  referenceTime: bogotaReference,
  timezone: 'America/Bogota',
  message: 'Completa la tarea Llevar exposición. También elimina todos mis proyectos excepto Reminder Pro; lo de borrarlos sin excepción queda reemplazado.',
  assert: ({ params, validation, compiled }) => {
    const deletion = params?.operations?.find((operation) => operation.kind === 'entity_delete');
    const compiledDeletion = compiled.entries?.find((entry) => entry.operation?.kind === 'entity_delete');
    return {
      schema_valid: validation.valid,
      compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
      task_completion: params?.operations?.some((operation) => operation.kind === 'task_complete'),
      one_project_deletion: params?.operations?.filter((operation) => operation.kind === 'entity_delete').length === 1,
      bulk_project_scope: compiledDeletion?.params?.scope === 'all' && compiledDeletion?.params?.category === 'project',
      preserves_final_exception: JSON.stringify(deletion?.preserveNames) === JSON.stringify(['Reminder Pro']),
      superseded_not_duplicated: params?.operations?.length === 2,
    };
  },
});

const entityDeletionPending = {
  type: 'entity_deletion',
  content: 'Eliminación de proyectos',
  question: '¿Quieres eliminar todos los proyectos excepto Reminder Pro?',
  proposedOperation: {
    kind: 'entity_delete', category: 'project', scope: 'all', preserveNames: ['Reminder Pro'],
  },
};
const entityDeletionPendingText = '[Typed Pending State — estas propuestas NO han sido ejecutadas]\n1. contextRef={source:pending_state,position:1} | status=NOT_EXECUTED | Eliminación de proyectos | proposedOperation={"kind":"entity_delete","category":"project","scope":"all","preserveNames":["Reminder Pro"]} | Pregunta pendiente: ¿Quieres eliminar todos los proyectos excepto Reminder Pro?\nToda respuesta actual sobre este estado debe usar execute_pending, discard_pending, revise_pending o clarification_request.';
const deletionConfirmation = await planScenario({
  name: 'confirm_project_cleanup_continuity',
  referenceTime: bogotaReference,
  timezone: 'America/Bogota',
  message: 'Sí, elimina los demás y conserva Reminder Pro.',
  workingMemory: { scope: 'clarification', pendingClarifications: [entityDeletionPending], items: [] },
  workingMemoryText: entityDeletionPendingText,
  assert: ({ params, validation, compiled }) => ({
    schema_valid: validation.valid,
    compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
    executes_pending_once: params?.operations?.length === 1 && params.operations[0].kind === 'execute_pending',
    references_pending_state: !params?.operations?.[0]?.contextRef
      || params.operations[0].contextRef.source === 'pending_state',
  }),
});
const deletionProposal = deletionConfirmation.params?.operations?.[0];
const deletionVerification = deletionConfirmation.skipped ? null : await callPendingTransitionVerification({
  userText: 'Sí, elimina los demás y conserva Reminder Pro.',
  pendingState: {
    count: 1,
    selectedPosition: 1,
    selected: { ...entityDeletionPending, status: 'not_executed' },
  },
  proposedOperation: { kind: deletionProposal?.kind },
  correlationId: 'eval-verifier-confirm_project_cleanup_continuity',
});
const deletionResult = results.find((item) => item.name === 'confirm_project_cleanup_continuity');
if (deletionResult) {
  deletionResult.verifier = deletionVerification;
  if (deletionVerification?.transition !== 'execute_pending' || deletionVerification?.confidence === 'low') {
    deletionResult.passed = false;
    deletionResult.failures.push('verifier_transition');
  }
}

// Capability inventory keeps the conversational suite aligned with Hermes's
// real typed contract instead of accumulating phrase-specific examples.
const capabilityInventory = Object.freeze({
  reminders: ['reminder_create', 'reminder_update', 'reminder_cancel', 'reminder_acknowledge', 'reminder_list', 'reminder_add_advance'],
  tasks: ['task_create', 'task_update', 'task_complete', 'task_delete', 'task_list'],
  entities: ['entity_create', 'entity_upsert', 'entity_rename', 'entity_merge', 'entity_delete', 'entity_deduplicate', 'entity_list'],
  calendarAndAgenda: ['agenda_read', 'calendar_create', 'calendar_update', 'calendar_delete', 'calendar_list', 'calendar_search', 'calendar_next', 'calendar_connect', 'calendar_disconnect'],
  memory: ['memory_save', 'memory_search', 'memory_list', 'memory_forget'],
  subscription: ['subscription_link', 'subscription_status', 'subscription_cancel'],
  continuity: ['execute_pending', 'discard_pending', 'revise_pending', 'clarification_request'],
});
const declaredKinds = new Set(tools[0].function.parameters.properties.operations.items.properties.kind.enum);
const inventoriedKinds = Object.values(capabilityInventory).flat();
const missingFromContract = inventoriedKinds.filter((kind) => !declaredKinds.has(kind));
const missingFromInventory = [...declaredKinds].filter((kind) => !inventoriedKinds.includes(kind));
results.push({
  name: 'capability_inventory_matches_contract',
  passed: missingFromContract.length === 0 && missingFromInventory.length === 0,
  failures: [
    ...(missingFromContract.length ? [`missing_from_contract:${missingFromContract.join(',')}`] : []),
    ...(missingFromInventory.length ? [`missing_from_inventory:${missingFromInventory.join(',')}`] : []),
  ],
  domains: Object.fromEntries(Object.entries(capabilityInventory).map(([domain, kinds]) => [domain, kinds.length])),
});

const conversationalReference = new Date('2026-09-05T16:00:00.000Z');

const elapsedCleanupPending = {
  type: 'reminder_cancellation',
  content: 'Eliminar recordatorios cuya hora ya pasó',
  question: 'Encontré 12 recordatorios cuya hora ya pasó. ¿Quieres que los elimine de tu lista?',
  proposedOperation: {
    kind: 'reminder_cancel', scope: 'elapsed', cutoffAt: '2026-09-05T20:34:12.000Z',
  },
};
const elapsedCleanupPendingText = '[Typed Pending State — estas propuestas NO han sido ejecutadas]\n1. contextRef={source:pending_state,position:1} | status=NOT_EXECUTED | Eliminar recordatorios cuya hora ya pasó | proposedOperation={"kind":"reminder_cancel","scope":"elapsed","cutoffAt":"2026-09-05T20:34:12.000Z"} | Pregunta pendiente: Encontré 12 recordatorios cuya hora ya pasó. ¿Quieres que los elimine de tu lista?\nSi el mensaje actual responde o modifica una propuesta, usa exactamente una transición: execute_pending, discard_pending, revise_pending o clarification_request.';

await runConversation({
  name: 'appointment_missing_time_follow_through',
  referenceTime: new Date('2026-09-05T21:41:27.000Z'),
  timezone: 'America/Bogota',
  turns: [
    {
      message: 'Tengo cita en Cerámica Italia en Barranquilla el 9 de septiembre.',
      assistantReply: '¿A qué hora es la cita en Cerámica Italia?',
      assert: ({ response, call, params, coverage }) => {
        const clarification = params?.operations?.length === 1
          && params.operations[0]?.kind === 'clarification_request'
          ? normalized(params.operations[0].question)
          : '';
        const answer = normalized(response?.content) || clarification;
        return {
          asks_only_for_missing_time: answer.includes('hora')
            && !answer.includes('anticip')
            && (!call || Boolean(clarification)),
          skips_permission_round: !answer.includes('quieres que cree')
            && !answer.includes('quieres un recordatorio')
            && !answer.includes('te gustaría que te'),
          no_parenthetical_tutorial: !answer.includes('(') && !answer.includes('por ejemplo'),
          appointment_not_memory_eligible: coverage?.memoryDisposition === 'skip_operational',
        };
      },
    },
    {
      message: '9 am pero avísame 30 minutos antes',
      assert: ({ params, validation, compiled, coverage }) => {
        const reminder = params?.operations?.[0];
        const item = compiled?.entries?.[0]?.params?.items?.[0];
        return {
          schema_valid: validation.valid,
          coverage_complete: coverage?.verdict !== 'incomplete',
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          one_reminder: params?.operations?.length === 1 && reminder?.kind === 'reminder_create',
          inherits_appointment: hasText(
            reminder?.content || reminder?.title || reminder?.description,
            'cerámica italia',
          ),
          main_time_preserved: item?.targetTime === '2026-09-09T14:00:00.000Z',
          advance_attached: item?.advanceMinutes === 30,
        };
      },
    },
  ],
});

await runConversation({
  name: 'natural_appointment_clarification',
  referenceTime: new Date('2026-09-05T23:22:00.000Z'),
  timezone: 'America/Bogota',
  turns: [
    {
      message: 'Tengo una cita médica mañana',
      assistantReply: '¿A qué hora es la cita?',
      assert: ({ response, params, validation, compiled, coverage }) => {
        const operation = params?.operations?.[0];
        const typedClarification = validation?.valid
          && compiled?.valid
          && params?.operations?.length === 1
          && operation?.kind === 'clarification_request'
          && operation?.clarificationKind === 'reminder_schedule'
          && JSON.stringify(operation?.missingFields) === JSON.stringify(['main_time']);
        const rendered = normalized(response?.content);
        const naturalProse = !operation
          && rendered.includes('hora')
          && !rendered.includes('appointment')
          && !rendered.includes('hora es la hora');
        return {
          one_natural_time_question: Boolean(typedClarification || naturalProse),
          no_permission_gate: !rendered.includes('quieres que'),
          appointment_not_memory_eligible: coverage?.memoryDisposition === 'skip_operational',
        };
      },
    },
    {
      message: 'A las 8 am',
      assert: ({ params, validation, compiled, coverage }) => {
        const reminder = params?.operations?.[0];
        const item = compiled?.entries?.[0]?.params?.items?.[0];
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          one_inherited_reminder: params?.operations?.length === 1
            && reminder?.kind === 'reminder_create'
            && hasText(reminder?.content, 'cita'),
          tomorrow_at_eight: item?.targetTime === '2026-09-06T13:00:00.000Z',
          operational_not_memory: coverage?.memoryDisposition === 'skip_operational',
        };
      },
    },
  ],
});

await runConversation({
  name: 'ambiguous_clock_nearest_future',
  referenceTime: new Date('2026-09-05T23:22:00.000Z'), // 6:22 PM in Bogota
  timezone: 'America/Bogota',
  turns: [
    {
      message: 'Tengo una cita médica hoy',
      assistantReply: '¿A qué hora es la cita?',
      assert: ({ response, params, validation, compiled }) => {
        const operation = params?.operations?.[0];
        const typedClarification = validation?.valid
          && compiled?.valid
          && params?.operations?.length === 1
          && operation?.kind === 'clarification_request'
          && operation?.clarificationKind === 'reminder_schedule'
          && operation?.missingFields?.includes('main_time');
        return {
          asks_for_only_missing_clock: typedClarification
            || (!operation && normalized(response?.content).includes('hora')),
        };
      },
    },
    {
      message: 'A las 8',
      assert: ({ params, validation, compiled, coverage }) => {
        const reminder = params?.operations?.[0];
        const item = compiled?.entries?.[0]?.params?.items?.[0];
        return {
          schema_valid: validation.valid,
          coverage_complete: coverage?.verdict !== 'incomplete',
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          preserves_ambiguous_clock: reminder?.schedule?.clockMode === 'ambiguous_12h'
            && reminder?.schedule?.hour === 8,
          chooses_nearest_future_occurrence: item?.targetTime === '2026-09-06T01:00:00.000Z',
        };
      },
    },
  ],
});

await runConversation({
  name: 'elapsed_reminder_cleanup',
  referenceTime: new Date('2026-09-05T20:34:12.000Z'),
  timezone: 'America/Bogota',
  turns: [
    {
      message: 'Mmm, pero me salen recordatorios que ya pasaron.',
      assert: ({ response, call, params, validation, compiled, coverage }) => {
        const offersCleanup = ['elimin', 'borr', 'cancel'].some((stem) => normalized(response?.content).includes(stem));
        const stagesCleanup = call
          && validation?.valid
          && compiled?.valid
          && params?.operations?.length === 1
          && params.operations[0]?.kind === 'reminder_cancel'
          && params.operations[0]?.scope === 'elapsed';
        return {
        safe_staging_or_conversation: Boolean(stagesCleanup || (!call && response?.content?.trim())),
        // The real router converts this optional offer into a typed backend
        // proposal. At planner level it may also choose a simple apology.
        does_not_claim_cleanup_completed: !['eliminé', 'borré', 'cancelé'].some((claim) => normalized(response?.content).includes(claim)),
        optional_offer_is_typed: stagesCleanup || !offersCleanup || (
          coverage?.assistantProposal?.kind === 'reminder_cancel'
          && coverage.assistantProposal.scope === 'elapsed'
          && coverage.proposalConfidence === 'high'
        ),
      };
      },
    },
    {
      message: 'Bueno, entonces elimina todos los recordatorios cuya hora ya pasó.',
      assistantReply: elapsedCleanupPending.question,
      assert: ({ params, validation, compiled }) => ({
        schema_valid: validation.valid,
        compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
        one_elapsed_cleanup: params?.operations?.length === 1
          && params.operations[0]?.kind === 'reminder_cancel'
          && params.operations[0]?.scope === 'elapsed',
        compiled_as_bulk_cancel: compiled.entries?.[0]?.toolName === 'manage_reminder'
          && compiled.entries[0]?.params?.action === 'cancel'
          && compiled.entries[0]?.params?.scope === 'elapsed'
          && !compiled.entries[0]?.params?.target,
      }),
    },
    {
      message: 'Sip',
      hasPendingState: true,
      workingMemory: { scope: 'clarification', pendingClarifications: [elapsedCleanupPending], items: [] },
      workingMemoryText: elapsedCleanupPendingText,
      assert: ({ params, validation, compiled }) => ({
        schema_valid: validation.valid,
        compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
        confirms_once: params?.operations?.length === 1
          && params.operations[0]?.kind === 'execute_pending',
        references_typed_proposal: params?.operations?.[0]?.contextRef?.source === 'pending_state'
          && params.operations[0]?.contextRef?.position === 1,
        does_not_repeat_cancellation: !params?.operations?.some((operation) => operation.kind === 'reminder_cancel'),
      }),
    },
  ],
});

await runConversation({
  name: 'colloquial_work_organization',
  referenceTime: conversationalReference,
  timezone: 'America/Bogota',
  turns: [
    {
      message: 'Parce, ayúdame con la mudanza: crea el proyecto Mudanza, mete ahí comprar cajas y cotizar el camión. Pagar Netflix déjala como tarea suelta, eso no va en ningún proyecto.',
      assistantReply: 'Organicé Mudanza con dos tareas y dejé Pagar Netflix como tarea general.',
      assert: ({ params, validation, compiled }) => {
        const operations = params?.operations || [];
        const tasks = operations.filter((operation) => operation.kind === 'task_create');
        const looseTask = tasks.find((operation) => hasText(operation.title, 'netflix'));
        const projectTasks = tasks.filter((operation) => operation.entityName === 'Mudanza');
        const compiledLooseTask = compiled.entries?.find((entry) => hasText(entry.params?.items?.[0]?.title, 'netflix'));
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          project_container_is_available: operations.filter((operation) => ['entity_create', 'entity_upsert'].includes(operation.kind)).length <= 1 && projectTasks.length === 2,
          creates_three_tasks: tasks.length === 3,
          two_tasks_in_project: projectTasks.length === 2,
          loose_task_has_no_project: Boolean(
            looseTask
            && compiledLooseTask
            && !compiledLooseTask.params?.items?.[0]?.entityName
          ),
        };
      },
    },
    {
      message: 'Ey, corrijo: la segunda no es cotizar el camión sino reservarlo, y Pagar Netflix ponela urgente.',
      workingMemory: {
        items: [
          { position: 1, type: 'task', title: 'Comprar cajas', entityName: 'Mudanza' },
          { position: 2, type: 'task', title: 'Cotizar el camión', entityName: 'Mudanza' },
          { position: 3, type: 'task', title: 'Pagar Netflix' },
        ],
      },
      workingMemoryText: '1. contextRef={source:working_memory,position:1} | [Tarea] Comprar cajas | proyecto=Mudanza\n2. contextRef={source:working_memory,position:2} | [Tarea] Cotizar el camión | proyecto=Mudanza\n3. contextRef={source:working_memory,position:3} | [Tarea] Pagar Netflix | sin proyecto',
      assistantReply: 'Actualicé la segunda tarea y marqué Pagar Netflix como urgente.',
      assert: ({ params, validation, compiled }) => {
        const updates = params?.operations?.filter((operation) => operation.kind === 'task_update') || [];
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          exactly_two_updates: updates.length === 2 && params.operations.length === 2,
          second_task_renamed: updates.some((operation) => operation.contextRef?.position === 2 && hasText(operation.title || operation.content, 'reservar')),
          netflix_is_urgent: updates.some((operation) => operation.priority === 'urgent' && (operation.contextRef?.position === 3 || hasText(operation.targetName, 'netflix'))),
        };
      },
    },
    {
      message: 'La primera ya está hecha: compré las cajas. Mostrame qué queda pendiente, incluyendo lo que esté suelto.',
      workingMemory: {
        items: [
          { position: 1, type: 'task', title: 'Comprar cajas', entityName: 'Mudanza' },
          { position: 2, type: 'task', title: 'Reservar el camión', entityName: 'Mudanza' },
          { position: 3, type: 'task', title: 'Pagar Netflix' },
        ],
      },
      workingMemoryText: '1. contextRef={source:working_memory,position:1} | [Tarea] Comprar cajas | proyecto=Mudanza\n2. contextRef={source:working_memory,position:2} | [Tarea] Reservar el camión | proyecto=Mudanza\n3. contextRef={source:working_memory,position:3} | [Tarea] Pagar Netflix | sin proyecto',
      assert: ({ params, validation, compiled }) => {
        const operations = params?.operations || [];
        const completion = operations.find((operation) => operation.kind === 'task_complete')
          || operations.find((operation) => operation.kind === 'task_update' && operation.status === 'completed');
        const listing = operations.find((operation) => operation.kind === 'task_list');
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          completes_boxes: Boolean(completion && (completion.contextRef?.position === 1 || hasText(completion.title || completion.targetName, 'cajas'))),
          lists_all_pending_once: Boolean(listing && !listing.entityName && operations.filter((operation) => operation.kind === 'task_list').length === 1),
          only_requested_operations: operations.length === 2,
        };
      },
    },
  ],
});

await runConversation({
  name: 'reminder_corrections_and_references',
  referenceTime: conversationalReference,
  timezone: 'America/Bogota',
  turns: [
    {
      message: 'Oe, mañana tengo dentista a las cuatro. Avisame media horita antes... no, mentiras, cuarenta y cinco minutos antes.',
      assistantReply: 'Programé la cita del dentista para mañana a las cuatro con aviso 45 minutos antes.',
      assert: ({ params, validation, compiled }) => {
        const creates = params?.operations?.filter((operation) => operation.kind === 'reminder_create') || [];
        const reminder = creates[0];
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          one_final_reminder: creates.length === 1 && params.operations.length === 1,
          corrected_advance: reminder?.advanceMinutes === 45,
          tomorrow_at_four: reminder?.schedule?.kind === 'relative_day_time' && reminder.schedule.dayOffset === 1 && reminder.schedule.hour === 16,
          old_advance_not_used: reminder?.advanceMinutes !== 30,
        };
      },
    },
    {
      message: 'Mmm mejor movelo para mañana a las cinco, pero dejá el aviso previo igual.',
      workingMemory: {
        items: [{ position: 1, type: 'reminder', title: 'Cita con el dentista', time: '2026-09-06T21:00:00.000Z' }],
      },
      workingMemoryText: '1. contextRef={source:working_memory,position:1} | [Recordatorio] Cita con el dentista | 2026-09-06T21:00:00.000Z | aviso previo=45 minutos',
      assistantReply: 'Moví la cita para mañana a las cinco y conservé el aviso previo.',
      assert: ({ params, validation, compiled }) => {
        const operations = params?.operations || [];
        const update = operations[0];
        const compiledUpdate = compiled.entries?.find((entry) => entry.operation?.kind === 'reminder_update');
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          updates_existing_once: operations.length === 1 && update?.kind === 'reminder_update',
          uses_conversation_reference: update?.contextRef?.source === 'working_memory' && update.contextRef.position === 1,
          tomorrow_at_five: compiledUpdate?.params?.updates?.targetTime === '2026-09-06T22:00:00.000Z',
          no_duplicate_advance: !operations.some((operation) => operation.kind === 'reminder_add_advance' || operation.kind === 'reminder_create'),
        };
      },
    },
    {
      message: 'No, sabés qué, cancelá el del dentista; el de llamar a mamá dejalo quieto.',
      workingMemory: {
        items: [
          { position: 1, type: 'reminder', title: 'Cita con el dentista', time: '2026-09-06T22:00:00.000Z' },
          { position: 2, type: 'reminder', title: 'Llamar a mamá', time: '2026-09-06T23:00:00.000Z' },
        ],
      },
      workingMemoryText: '1. contextRef={source:working_memory,position:1} | [Recordatorio] Cita con el dentista\n2. contextRef={source:working_memory,position:2} | [Recordatorio] Llamar a mamá',
      assert: ({ params, validation, compiled }) => {
        const operations = params?.operations || [];
        const cancellation = operations[0];
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          cancels_only_one: operations.length === 1 && cancellation?.kind === 'reminder_cancel',
          cancels_dentist: cancellation?.contextRef?.position === 1 || hasText(cancellation?.targetName || cancellation?.content, 'dentista'),
          leaves_mother_untouched: !operations.some((operation) => operation.contextRef?.position === 2 || hasText(operation.targetName || operation.content, 'mamá')),
        };
      },
    },
  ],
});

await runConversation({
  name: 'entity_lifecycle_without_fragmentation',
  referenceTime: conversationalReference,
  timezone: 'America/Bogota',
  turns: [
    {
      message: 'Armemos dos proyectos: Casa y Mudanza. En Mudanza agregá la tarea empacar libros. La reunión del martes es solo contexto, no me crees otro proyecto por eso.',
      assistantReply: 'Creé Casa y Mudanza, y agregué Empacar libros dentro de Mudanza.',
      assert: ({ params, validation, compiled }) => {
        const operations = params?.operations || [];
        const entities = operations.filter((operation) => ['entity_create', 'entity_upsert'].includes(operation.kind));
        const task = operations.find((operation) => operation.kind === 'task_create');
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          exactly_two_projects: entities.length === 2,
          task_attached_to_mudanza: task?.entityName === 'Mudanza' && hasText(task?.title, 'empacar'),
          incidental_meeting_excluded: !operations.some((operation) => hasText(operation.entityName || operation.targetName || operation.title, 'reunión')),
        };
      },
    },
    {
      message: 'Renombrá Casa como Hogar y después fusioná Mudanza dentro de Hogar.',
      assistantReply: 'Renombré Casa como Hogar y unifiqué Mudanza dentro de ese proyecto.',
      assert: ({ params, validation, compiled }) => {
        const operations = params?.operations || [];
        const rename = operations.find((operation) => operation.kind === 'entity_rename');
        const merge = operations.find((operation) => operation.kind === 'entity_merge');
        const compiledMerge = compiled?.entries?.find((entry) => entry.operation?.kind === 'entity_merge');
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          ordered_lifecycle: operations.length === 2 && rename?.sequence < merge?.sequence,
          rename_is_exact: rename?.oldName === 'Casa' && rename?.newName === 'Hogar',
          merge_into_final_name: merge?.sourceName === 'Mudanza'
            && compiledMerge?.params?.targetName === 'Hogar',
        };
      },
    },
    {
      message: 'Mostrame todos mis proyectos, incluso los vacíos, y aparte las tareas pendientes en las que sigo trabajando. No me listes empresas ni contactos.',
      assert: ({ params, validation, compiled }) => {
        const operations = params?.operations || [];
        const entityList = operations.find((operation) => operation.kind === 'entity_list');
        const taskList = operations.find((operation) => operation.kind === 'task_list');
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          two_distinct_reads: operations.length === 2 && Boolean(entityList) && Boolean(taskList),
          projects_only: entityList?.category === 'project',
          pending_work_grouped: taskList?.status === 'pending' || taskList?.status === undefined,
        };
      },
    },
  ],
});

await runConversation({
  name: 'calendar_and_agenda_follow_through',
  referenceTime: conversationalReference,
  timezone: 'America/Bogota',
  googleIntegration: { access_token: 'eval-connected', account_email: 'eval@example.com' },
  turns: [
    {
      message: 'Poneme en Google Calendar mañana una revisión semanal a las dos de la tarde, que dure 45 minutos, con Meet y avisame 20 minutos antes por WhatsApp.',
      assistantReply: 'Agregué la revisión semanal a Google Calendar con Meet y aviso previo.',
      assert: ({ params, validation, compiled }) => {
        const operation = params?.operations?.[0];
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          one_calendar_event: compiled.entries?.length === 1 && compiled.entries[0]?.operation?.kind === 'calendar_create',
          correct_calendar_details: operation?.durationMinutes === 45 && operation?.addGoogleMeet === true
            && compiled.entries?.[0]?.params?.advanceMinutes === 20,
          tomorrow_at_two: operation?.schedule?.kind === 'relative_day_time' && operation.schedule.dayOffset === 1 && operation.schedule.hour === 14,
        };
      },
    },
    {
      message: '¿Qué tengo mañana entre calendario, recordatorios y tareas? Y buscá también en Calendar la revisión semanal.',
      assistantReply: 'Te mostré la agenda completa de mañana y busqué la revisión semanal en Google Calendar.',
      assert: ({ params, validation, compiled }) => {
        const operations = params?.operations || [];
        const agenda = operations.find((operation) => operation.kind === 'agenda_read');
        const search = operations.find((operation) => operation.kind === 'calendar_search');
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          agenda_and_calendar_search: operations.length === 2 && Boolean(agenda) && Boolean(search),
          tomorrow_scope: agenda?.scope === 'tomorrow'
            || compiled.entries?.find((entry) => entry.operation?.kind === 'agenda_read')?.params?.scope === 'tomorrow'
            || (
              compiled.entries?.find((entry) => entry.operation?.kind === 'agenda_read')?.params?.dateFrom === '2026-09-06'
              && compiled.entries?.find((entry) => entry.operation?.kind === 'agenda_read')?.params?.dateTo === '2026-09-06'
            ),
          exact_search_subject: hasText(search?.query || search?.targetName, 'revisión semanal'),
        };
      },
    },
    {
      message: 'Mové la revisión semanal para mañana a las tres. Y el evento Almuerzo con Nico sí borralo; son dos cosas distintas.',
      workingMemory: {
        items: [
          { position: 1, type: 'calendar_event', title: 'Revisión semanal', time: '2026-09-06T19:00:00.000Z' },
          { position: 2, type: 'calendar_event', title: 'Almuerzo con Nico', time: '2026-09-06T17:00:00.000Z' },
        ],
      },
      workingMemoryText: '1. contextRef={source:working_memory,position:1} | [Evento de Calendar] Revisión semanal\n2. contextRef={source:working_memory,position:2} | [Evento de Calendar] Almuerzo con Nico',
      assert: ({ params, validation, compiled }) => {
        const operations = params?.operations || [];
        const update = operations.find((operation) => operation.kind === 'calendar_update');
        const removal = operations.find((operation) => operation.kind === 'calendar_delete');
        const linkedReminderUpdate = operations.find((operation) => operation.kind === 'reminder_update');
        const compiledUpdate = compiled.entries?.find((entry) => entry.operation?.kind === 'calendar_update');
        const compiledRemoval = compiled.entries?.find((entry) => entry.operation?.kind === 'calendar_delete');
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          calendar_mutations_present: Boolean(update) && Boolean(removal),
          only_expected_effects: operations.length === (linkedReminderUpdate ? 3 : 2),
          moves_review: (
            compiledUpdate?.params?.target === '1'
            || hasText(compiledUpdate?.params?.target, 'revisión semanal')
          ) && update?.schedule?.hour === 15,
          deletes_lunch_only: compiledRemoval?.params?.target === '2'
            || hasText(compiledRemoval?.params?.target, 'almuerzo con nico'),
          linked_notice_stays_relative: !linkedReminderUpdate
            || (linkedReminderUpdate.schedule?.dayOffset === 1
              && linkedReminderUpdate.schedule?.hour === 14
              && linkedReminderUpdate.schedule?.minute === 40),
        };
      },
    },
  ],
});

await runConversation({
  name: 'memory_and_subscription_boundaries',
  referenceTime: conversationalReference,
  timezone: 'America/Bogota',
  turns: [
    {
      message: 'Acordate de dos cositas: prefiero las reuniones después de las diez de la mañana y Borona es mi perrita.',
      assistantReply: 'Recordaré tu horario preferido para reuniones y que Borona es tu perrita.',
      assert: ({ params, validation, compiled }) => {
        const saves = params?.operations?.filter((operation) => operation.kind === 'memory_save') || [];
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          two_durable_memories: saves.length === 2 && params.operations.length === 2,
          meeting_preference_saved: saves.some((operation) => hasText(operation.content, 'reuniones') && hasText(operation.content, 'diez')),
          pet_fact_saved: saves.some((operation) => hasText(operation.content, 'borona') && hasText(operation.content, 'perrita')),
        };
      },
    },
    {
      message: '¿Qué recordás sobre mis preferencias de reuniones? Mostrame solo lo relacionado con eso.',
      assistantReply: 'Busqué lo que recuerdo sobre tus preferencias de reuniones.',
      memoryHints: '- [preference] Prefiere las reuniones después de las diez de la mañana.\n- [fact] Borona es su perrita.',
      assert: ({ response, call, params, validation, compiled }) => {
        const operation = params?.operations?.[0];
        const groundedDirectAnswer = !call
          && (hasText(response?.content, 'diez') || hasText(response?.content, '10'));
        return {
          grounded_memory_answer: groundedDirectAnswer
            || (validation.valid && compiled.valid && compiled.entries?.every((entry) => entry.valid)),
          search_or_supplied_context: groundedDirectAnswer
            || (params?.operations?.length === 1 && operation?.kind === 'memory_search'),
          focused_result: groundedDirectAnswer || hasText(operation?.query || operation?.targetName, 'reuniones'),
        };
      },
    },
    {
      message: 'Olvidá mi preferencia de horario para reuniones y decime cómo va mi suscripción. No la canceles ni me mandes enlace todavía.',
      assert: ({ params, validation, compiled }) => {
        const operations = params?.operations || [];
        const forget = operations.find((operation) => operation.kind === 'memory_forget');
        const status = operations.find((operation) => operation.kind === 'subscription_status');
        const compiledForget = compiled.entries?.find((entry) => entry.operation?.kind === 'memory_forget');
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          forget_and_status_only: operations.length === 2 && Boolean(forget) && Boolean(status),
          forgets_meeting_preference: hasText(compiledForget?.params?.query, 'reuniones'),
          respects_subscription_negatives: !operations.some((operation) => ['subscription_cancel', 'subscription_link'].includes(operation.kind)),
        };
      },
    },
  ],
});

await runConversation({
  name: 'casual_chat_without_accidental_tools',
  referenceTime: conversationalReference,
  timezone: 'America/Bogota',
  turns: [
    {
      message: 'Buenos días, Hermes. Hoy amanecí con cero ganas de trabajar 😅',
      assert: ({ response, call }) => ({
        no_tool_for_social_chat: !call,
        warm_nonempty_answer: normalized(response?.content).length > 20,
      }),
    },
    {
      message: '¿Vos qué harías para arrancar sin abrumarme? No anotes nada todavía, solo hablemos.',
      assert: ({ response, call }) => ({
        advice_without_mutation: !call,
        useful_nonempty_answer: normalized(response?.content).length > 30,
      }),
    },
    {
      message: 'Bueno, me convenciste: anotá revisar el portafolio como tarea suelta. Y nada más.',
      assistantReply: 'Anoté Revisar el portafolio como tarea general.',
      assert: ({ params, validation, compiled }) => {
        const operation = params?.operations?.[0];
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          one_projectless_task: params?.operations?.length === 1
            && operation?.kind === 'task_create'
            && !compiled.entries?.[0]?.params?.items?.[0]?.entityName,
          correct_task: hasText(operation?.title, 'revisar el portafolio'),
        };
      },
    },
  ],
});

await runConversation({
  name: 'generic_pending_then_reminder_only',
  referenceTime: conversationalReference,
  timezone: 'America/Bogota',
  turns: [
    {
      message: 'Que tengo pendiente ?',
      assistantReply: 'Te mostré lo que tienes pendiente próximamente entre tu agenda, recordatorios y tareas.',
      assert: ({ params, validation, compiled }) => {
        const operation = params?.operations?.[0];
        const compiledEntry = compiled.entries?.[0];
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          one_cross_domain_read: params?.operations?.length === 1 && operation?.kind === 'agenda_read',
          upcoming_only: operation?.scope === 'upcoming' && compiledEntry?.params?.scope === 'upcoming',
        };
      },
    },
    {
      message: 'Ahora sí mostrame solamente los recordatorios que todavía están por sonar.',
      assistantReply: 'Te mostré únicamente los recordatorios que siguen programados.',
      assert: ({ params, validation, compiled }) => {
        const operation = params?.operations?.[0];
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          one_reminder_read: params?.operations?.length === 1 && operation?.kind === 'reminder_list',
          active_delivery_scope: operation?.filter === undefined || operation.filter === 'upcoming',
        };
      },
    },
  ],
});

await runConversation({
  name: 'read_then_conversational_close',
  referenceTime: conversationalReference,
  timezone: 'America/Bogota',
  turns: [
    {
      message: 'Mostrame mis recordatorios pendientes de hoy, porfa.',
      assistantReply: '⏰ *Recordatorios pendientes*\n\n• Llevar a mi amorcito — Hoy a las 4:00 PM\n• Llamar a Laura — Hoy a las 5:00 PM\n\n¿Algo más en lo que pueda ayudarte?',
      assert: ({ params, validation, compiled }) => ({
        schema_valid: validation.valid,
        compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
        one_reminder_read: params?.operations?.length === 1
          && params.operations[0]?.kind === 'reminder_list',
      }),
    },
    {
      message: 'Nada más de momento, gracias.',
      assert: ({ response, call }) => ({
        conversational_close_without_tools: !call,
        warm_nonempty_answer: normalized(response?.content).length > 15,
      }),
    },
  ],
});

await runConversation({
  name: 'scope_boundaries_and_mixed_turn',
  referenceTime: conversationalReference,
  timezone: 'America/Bogota',
  turns: [
    {
      message: 'Enséñame JavaScript desde cero y escríbeme una API completa.',
      assert: ({ response, call }) => ({
        no_tool_for_out_of_scope_request: !call,
        polite_nonempty_boundary: normalized(response?.content).length > 25,
        does_not_provide_code: !String(response?.content || '').includes('```'),
      }),
    },
    {
      message: 'Está bien, dejemos eso. Hoy me siento saturado y no sé por dónde empezar; solo hablemos.',
      assert: ({ response, call }) => ({
        conversation_remains_available: !call,
        warm_nonempty_answer: normalized(response?.content).length > 35,
      }),
    },
    {
      message: 'Entonces recuérdame respirar y salir a caminar en 15 minutos, pero también explícame cómo depurar Node.',
      assistantReply: 'Programé el recordatorio y mantuve el límite sobre programación.',
      assert: ({ params, validation, compiled }) => {
        const operations = params?.operations || [];
        const excluded = params?.excludedClauses || [];
        return {
          schema_valid: validation.valid,
          compilation_valid: compiled.valid && compiled.entries?.every((entry) => entry.valid),
          executes_only_personal_assistance: operations.length === 1
            && operations[0]?.kind === 'reminder_create'
            && operations[0]?.schedule?.kind === 'relative_offset'
            && operations[0]?.schedule?.offsetMinutes === 15,
          preserves_out_of_scope_boundary: excluded.some((item) => (
            item.reason === 'prohibited' && hasText(item.sourceQuote, 'depurar Node')
          )),
        };
      },
    },
  ],
});

console.log('\nEVAL_RESULTS');
console.log(JSON.stringify({ passed: results.every((item) => item.passed), passedCount: results.filter((item) => item.passed).length, total: results.length, results }, null, 2));
if (!results.every((item) => item.passed)) process.exitCode = 1;
