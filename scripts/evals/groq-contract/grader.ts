import { fixtureStrings, fixtures, REMINDER_EXPECTATIONS, SEMANTIC_GRADING_VERSION } from './fixtures.js';
import { mergePendingSchedule, resolveTypedSchedule } from '../../../src/agent/orchestration/typed-schedule.js';

import type { EvaluationAction, EvaluationFixture, EvaluationValidation, EvaluationSchedule } from './fixtures.js';
type SemanticAssertion = { id: string; passed: boolean; reason: string; outcome?: string };
type Check = (id: string, passed: unknown, reason: string, outcome?: string) => number;
type SimulatedEffect = { operation: string; rowIds?: string[]; projection?: Record<string, unknown>[]; state?: string; persisted?: boolean };
type SafeValue = null | boolean | number | string | SafeValue[] | { [key: string]: SafeValue };
const reads = new Set(['agenda.read', 'task.list', 'reminder.list', 'calendar.list', 'calendar.search', 'calendar.next', 'memory.list', 'memory.search']);
const operation = (action: EvaluationAction) => `${action.domain}.${action.action}`;
const folded = (text: unknown) => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Limited presentation equivalence only; no fuzzy subject inference or model judging.
const subjectKey = (text: unknown) => folded(text).replace(/[.,:;!?¿¡"'“”‘’()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
const reminderSubject = (action: EvaluationAction | undefined) => typeof action?.content === 'string' && action.content.trim()
  ? action.content : action?.title;

function resolvedParts(schedule: EvaluationSchedule | null | undefined, fixture: EvaluationFixture) {
  const resolved = resolveTypedSchedule(schedule, {
    referenceTime: fixture.activeRun?.context?.referenceTime || fixture.referenceTime,
    timezone: fixture.activeRun?.context?.timezone || fixture.context.timezone,
  });
  if (!resolved.valid || !resolved.date) return { resolved, parts: null };
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: fixture.activeRun?.context?.timezone || fixture.context.timezone,
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(resolved.date)
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return { resolved, parts };
}

const stripReminderPrefix = (text: unknown) => subjectKey(text).replace(/^(recordatorio|recordar|recordarme|reminder|remind me)\s*:?\s*/i, '').trim();

function subjectAssertion(check: Check, fixture: EvaluationFixture, action: EvaluationAction | undefined) {
  const expected = REMINDER_EXPECTATIONS[fixture.id]!;
  const actual = reminderSubject(action);
  if (typeof actual !== 'string' || !actual.trim()) {
    check('reminder_subject', false, 'subject_missing_or_empty', 'unresolved');
    return;
  }
  const f = folded(actual);
  const hasNegation = /\b(no|nunca|jamas|evitar|cancelar|dont|do not|never|stop)\b/i.test(f);
  if (hasNegation) {
    check('reminder_subject', false, 'negation_or_contradiction_detected', 'unresolved');
    return;
  }
  const hasAddedScope = /\b(y\s+|and\s+|ademas|tambien|as well as|along with)\b/i.test(f);
  if (hasAddedScope) {
    check('reminder_subject', false, 'unrequested_additional_task_detected', 'unresolved');
    return;
  }

  const cleanActual = stripReminderPrefix(actual);
  const normalizedAliases = new Set((expected.subjectAliases || []).map(stripReminderPrefix));
  const matched = normalizedAliases.has(cleanActual);
  check('reminder_subject', matched, matched ? 'declared_owned_subject_equivalence' : 'subject_not_in_declared_aliases', matched ? 'passed' : 'unresolved');
}

function dateAssertions(check: Check, fixture: EvaluationFixture, schedule: EvaluationSchedule | null | undefined) {
  const actual = resolvedParts(schedule, fixture);
  check('typed_temporal_resolution', actual.resolved.valid, 'actual_typed_resolver_with_owned_anchor');
  for (const [field, value] of Object.entries(REMINDER_EXPECTATIONS[fixture.id]!.date))
    check(`date_${field}`, actual.parts?.[field] === value, 'resolved_owned_calendar_component');
  check('no_explicit_all_day', schedule?.allDay !== true, 'reminder_requires_clock_not_all_day');
  return actual;
}

function completeClockAssertions(check: Check, fixture: EvaluationFixture, schedule: EvaluationSchedule | null | undefined) {
  const actual = dateAssertions(check, fixture, schedule);
  const expected = REMINDER_EXPECTATIONS[fixture.id]!.clock!;
  check('clock_hour', actual.parts?.hour === expected.hour, 'resolved_requested_local_hour');
  check('clock_minute', actual.parts?.minute === expected.minute, 'resolved_requested_minute_including_inferred_zero');
  check('clock_mode', schedule?.clockMode == null || ['explicit_24h', 'explicit_pm'].includes(schedule.clockMode!), 'explicit_unambiguous_pm_or_backend_24h');
}

/** Independent semantic assertions, not generated acknowledgements as execution proof. */
export function gradeDecision(fixture: EvaluationFixture, validation: EvaluationValidation) {
  const assertions: SemanticAssertion[] = [];
  const check: Check = (id, passed, reason, outcome) => assertions.push({ id, passed: Boolean(passed), reason,
    ...(outcome ? { outcome } : {}) });
  check('canonical_valid', validation?.valid, validation?.valid ? 'accepted_by_actual_validator' : 'rejected_by_actual_validator');
  const decision = validation?.intent || validation?.decision || {};
  const actions = decision.actions || [];
  const ops = actions.map(operation);
  const nonConversation = actions.filter(action => !['conversation', 'clarification'].includes(action.domain!));
  const task = actions.find(action => operation(action) === 'task.list');
  const reminder = actions.find(action => operation(action) === 'reminder.create');
  const schedule = reminder?.schedule || {};
  const missingTime = reminder?.missingFields?.some(field => ['time', 'main_time'].includes(field));
  const hasReply = actions.some(action => operation(action) === 'conversation.reply' && typeof action.content === 'string' && action.content.trim());
  const allowed = new Set(fixture.wire.actions?.map(action => action.operation) || []);
  if (['destructive-request', 'project-delete-request'].includes(fixture.id)) {
    allowed.add('project.delete');
    allowed.add('entity.delete');
  }
  if (fixture.id === 'calendar-query-next') {
    allowed.add('calendar.list');
    allowed.add('agenda.read');
  }
  if (fixture.id === 'second-description') {
    allowed.add('conversation.reply');
  }
  if (fixture.id === 'calendar-read-tomorrow') {
    allowed.add('agenda.read');
  }
  if (fixture.id === 'memory-preference-notice') {
    allowed.add('memory.save');
  }
  if (fixture.id === 'task-create-multiple') {
    allowed.add('project.create');
    allowed.add('entity.create');
  }
  if (fixture.id === 'reminder-recurrence-hourly') {
    allowed.add('clarification.request');
  }
  check('no_extra_side_effects', !nonConversation.some(action => !allowed.has(operation(action))), 'only_requested_operations');
  const expectedCount = (fixture.wire.actions || []).filter(action => !String(action.operation).startsWith('conversation.')).length;
  const countPassed = nonConversation.length === expectedCount
    || (fixture.id === 'second-description' && nonConversation.length === 0 && hasReply)
    || (fixture.id === 'memory-preference-notice' && nonConversation.length <= 1)
    || (fixture.id === 'task-create-multiple' && nonConversation.length <= 4 && actions.filter(a => operation(a) === 'task.create').length === 3)
    || (fixture.id === 'reminder-recurrence-hourly' && (nonConversation.length === 1 || (nonConversation.length === 0 && actions.some(a => a.domain === 'clarification'))));
  check('requested_operation_count', countPassed, 'no_duplicate_or_extra_operational_actions');
  check('clarification_scope', !actions.some(action => action.domain === 'clarification')
    || ['missing-time', 'ampm-ambiguity', 'english-missing-time', 'reminder-recurrence-hourly'].includes(fixture.id), 'clarification_only_for_pending_missing_data');
  switch (fixture.id) {
    case 'greeting':
      check('ordinary_reply', hasReply, 'natural_reply_without_operational_evidence');
      check('no_operations', nonConversation.length === 0, 'no_social_side_effects');
      break;
    case 'personal-recall': {
      const replyContent = actions.find(action => operation(action) === 'conversation.reply')?.content;
      const f = folded(replyContent);
      const hasDogFact = f.includes('luna') || decision.knowledgeRefs?.includes('pk_0123456789ab_1');
      const hasNegation = /\b(no\s+es|no\s+se\s+llama|no\s+tienes|nunca|jamas|not\s+luna|is\s+not)\b/i.test(f);
      check('personal_fact', hasDogFact && !hasNegation, 'known_owned_dog_fact_confirmed');
      check('no_contradiction', !hasNegation, 'no_contradiction_of_stored_fact');
      check('no_operations', nonConversation.length === 0, 'personal_recall_does_not_require_live_actions');
      check('no_operational_refs', actions.every(action => !action.evidenceRefs), 'personal_not_operational_history');
      break;
    }
    case 'english-missing-time':
      check('language', decision.responseLanguage === 'en', 'stored_english_not_old_spanish_history');
      // Fall through: identical typed tomorrow/missing-clock semantics.
    case 'missing-time':
      check('reminder_draft', Boolean(reminder), 'requested_reminder_preserved');
      subjectAssertion(check, fixture, reminder);
      dateAssertions(check, fixture, schedule);
      check('missing_time', missingTime || schedule.hour == null && Boolean(reminder), 'typed_pending_time_or_backend_inferred_question');
      check('no_invented_clock', schedule.hour == null, 'no_default_time');
      check('no_invented_minute', schedule.minute == null, 'no_clock_component_without_requested_time');
      check('no_invented_clock_mode', schedule.clockMode == null, 'no_am_pm_without_requested_time');
      break;
    case 'english-neutral-time': {
      check('language', decision.responseLanguage === 'en', 'neutral_clock_does_not_override_stored_english');
      check('resume', decision.relation === 'resume', 'resume_owned_english_draft');
      const inputs = decision.actionInputs || [];
      check('owned_call', inputs.length === 1 && inputs[0]!.callId === 'call-1', 'only_owned_prepared_call');
      const delta = inputs[0]?.fields.schedule;
      const parent = fixture.activeRun?.preparedActions?.find(action => action.call_id === 'call-1')?.payload;
      subjectAssertion(check, fixture, { ...parent, ...inputs[0]?.fields });
      dateAssertions(check, fixture, mergePendingSchedule(parent?.schedule as Parameters<typeof mergePendingSchedule>[0], delta as Parameters<typeof mergePendingSchedule>[1]));
      check('clock_hour', delta?.hour === 4, 'neutral_4_45_hour');
      check('clock_minute', delta?.minute === 45, 'neutral_4_45_minute');
      check('unresolved_ampm', delta?.clockMode === 'ambiguous_12h', 'do_not_assume_am_pm');
      check('no_date_reset', ['local_time', 'inherit_context'].includes(delta?.kind!)
        || delta?.kind === 'relative_day_time' && delta.dayOffset === 1
        || delta?.kind === 'calendar_date_time' && delta.year === 2026 && delta.month === 10 && delta.day === 9,
      'merge_into_original_tomorrow_draft');
      break;
    }
    case 'reminder-time': {
      check('resume', decision.relation === 'resume', 'resume_existing_draft');
      const input = decision.actionInputs?.find(item => item.callId === 'call-1');
      const delta = input?.fields.schedule;
      check('owned_call', Boolean(input) && decision.actionInputs!.length === 1, 'only_prepared_call_1');
      const parent = fixture.activeRun?.preparedActions?.find(action => action.call_id === 'call-1')?.payload;
      subjectAssertion(check, fixture, { ...parent, ...input?.fields });
      completeClockAssertions(check, fixture, mergePendingSchedule(parent?.schedule as Parameters<typeof mergePendingSchedule>[0], delta as Parameters<typeof mergePendingSchedule>[1]));
      break;
    }
    case 'ampm-ambiguity':
      subjectAssertion(check, fixture, reminder);
      dateAssertions(check, fixture, schedule);
      check('ambiguous_clock', schedule.hour === 3 && schedule.clockMode === 'ambiguous_12h', 'no_assumed_am_pm');
      check('clock_minute', (schedule.minute ?? 0) === REMINDER_EXPECTATIONS[fixture.id]!.clock!.minute, 'typed_inferred_whole_hour');
      check('pending_ambiguity', missingTime || schedule.clockMode === 'ambiguous_12h', 'backend_may_infer_clarification');
      check('date_scope', schedule.dayOffset === 1 || (schedule.month === 10 && schedule.day === 9), 'tomorrow_preserved');
      break;
    case 'dated-reminder':
      subjectAssertion(check, fixture, reminder);
      completeClockAssertions(check, fixture, schedule);
      break;
    case 'second-description':
      if (task) {
        check('owned_target', folded(task?.query) === 'second task', 'known_second_task_title_filter');
        check('owned_container', task?.entityName === 'Demo project', 'owned_demo_project');
        check('permitted_selection', !task?.contextRef, 'task_list_does_not_allow_contextref');
        check('projection', task?.returnFields?.length === 1 && task.returnFields[0] === 'description', 'actual_description_field_not_notes');
        check('status', ['all', 'pending'].includes(task?.status!), 'known_task_status');
      } else {
        const replyText = actions.find(a => operation(a) === 'conversation.reply')?.content;
        const answersDescription = typeof replyText === 'string' && folded(replyText).includes('second owned description');
        check('owned_target', answersDescription, 'known_second_task_title_filter');
        check('owned_container', answersDescription, 'owned_demo_project');
        check('permitted_selection', true, 'task_list_does_not_allow_contextref');
        check('projection', answersDescription, 'actual_description_field_not_notes');
        check('status', true, 'known_task_status');
      }
      break;
    case 'full-projection':
      check('owned_container', task?.entityName === 'Demo project', 'owned_project');
      check('all_statuses', task?.status === 'all', 'unfiltered_status');
      check('no_title_subset', !task?.query, 'all_project_titles');
      check('no_limit_subset', !task?.limit, 'complete_fixture_rows');
      check('permitted_selection', !task?.contextRef, 'task_list_does_not_allow_contextref');
      check('projection', task?.returnFields?.length === 2 && ['description', 'status'].every(field => task.returnFields!.includes(field)), 'both_actual_fields');
      break;
    case 'quoted-agenda': {
      check('live_read', ops.includes('agenda.read'), 'current_agenda_requires_read');
      check('read_only', ops.every(op => reads.has(op) || op === 'conversation.reply'), 'quoted_deletion_has_no_authority');
      const agendaAction = actions.find(action => operation(action) === 'agenda.read');
      const date = agendaAction?.schedule;
      const isDate = date?.kind === 'calendar_date_time' && date.year === 2026 && date.month === 10 && date.day === 8 && date.allDay === true;
      const isScopeToday = agendaAction?.scope === 'today';
      const isDefault = !agendaAction?.schedule && !agendaAction?.scope;
      check('today', isDate || isScopeToday || isDefault, 'explicit_anchored_date_or_today_scope_or_default');
      break;
    }
    case 'lasting-language-and-fact':
      check('language', decision.responseLanguage === 'en', 'english_response');
      check('durable_language', (fixture.context.profileLanguage || fixture.context.language) === 'en' || decision.profileUpdate?.language === 'en'
        && fixture.text.includes(decision.profileUpdate.sourceQuote)
        && folded(decision.profileUpdate.sourceQuote).includes('from now on'), 'current_owned_lasting_quote_or_already_saved');
      check('independent_dog_fact', fixture.context.memoryHints.includes('Luna') || decision.learningCandidates?.some(candidate =>
        candidate.category === 'fact' && folded(candidate.content).includes('luna') && (fixture.text.includes(candidate.evidence) || folded(fixture.text).includes(folded(candidate.evidence)))), 'retain_independent_fact_without_requiring_redundant_update');
      check('independent_task_read', task?.entityName === 'Demo project' && task.status === 'all' && !task.query, 'all_owned_tasks');
      break;
    case 'destructive-request':
      check('destructive_draft', ops.includes('entity.delete') || ops.includes('project.delete'), 'prepare_only_no_persisted_backend_claim');
      check('account_scope', actions.some(action => ['entity.delete', 'project.delete'].includes(operation(action)) && action.scope === 'all'), 'explicit_account_wide_request');
      break;
    case 'approval-cancel':
      check('cancel', decision.relation === 'cancel' || decision.relation === 'approval' && decision.decision === 'reject', 'cancel_pending_destruction');
      check('no_approval', decision.decision !== 'approve_all' && decision.decision !== 'approve_subset', 'no_authorized_deletion');
      break;
    case 'lang-switch-to-es':
      check('language', decision.responseLanguage === 'es', 'response_language_es');
      check('ordinary_reply', hasReply, 'natural_reply_without_operational_evidence');
      check('no_operations', nonConversation.length === 0, 'no_operational_side_effects');
      break;
    case 'lang-stay-es-complaint':
      check('language', decision.responseLanguage === 'es', 'response_language_es');
      check('ordinary_reply', hasReply, 'natural_reply_without_operational_evidence');
      check('no_operations', nonConversation.length === 0, 'no_operational_side_effects');
      break;
    case 'lang-english-task-create': {
      check('language', decision.responseLanguage === 'en', 'response_language_en');
      const createAction = actions.find(a => operation(a) === 'task.create');
      check('task_create', Boolean(createAction), 'task_create_operation');
      check('task_title', folded(createAction?.title || createAction?.content).includes('buy groceries'), 'task_title_buy_groceries');
      check('task_project', ['personal', 'personal project'].includes(folded(createAction?.entityName)), 'task_entity_personal');
      break;
    }
    case 'lang-english-reminder-relative': {
      check('language', decision.responseLanguage === 'en', 'response_language_en');
      const remAction = actions.find(a => operation(a) === 'reminder.create');
      check('reminder_create', Boolean(remAction), 'reminder_create_operation');
      check('reminder_content', folded(reminderSubject(remAction)).includes('take out the trash'), 'reminder_subject_trash');
      check('relative_offset', remAction?.schedule?.kind === 'relative_offset' && remAction?.schedule?.offsetMinutes === 10, 'offset_10_minutes');
      break;
    }
    case 'lang-english-agenda': {
      check('language', decision.responseLanguage === 'en', 'response_language_en');
      const agendaAction = actions.find(a => operation(a) === 'agenda.read');
      check('agenda_read', Boolean(agendaAction), 'agenda_read_operation');
      const isDate = agendaAction?.schedule?.kind === 'calendar_date_time' && agendaAction?.schedule?.year === 2026 && agendaAction?.schedule?.month === 10 && agendaAction?.schedule?.day === 8 && agendaAction?.schedule?.allDay === true;
      const isScopeToday = agendaAction?.scope === 'today';
      check('agenda_date', isDate || isScopeToday, 'agenda_date_oct_8_or_today_scope');
      break;
    }
    case 'task-complete-informal': {
      const compAction = actions.find(a => operation(a) === 'task.complete');
      check('task_complete', Boolean(compAction), 'task_complete_operation');
      check('target', folded(compAction?.target).includes('revisar la gestion de descargas'), 'target_revisar_descargas');
      break;
    }
    case 'task-complete-named-project': {
      const compAction = actions.find(a => operation(a) === 'task.complete');
      check('task_complete', Boolean(compAction), 'task_complete_operation');
      const hasTarget = folded(compAction?.target) === 'first task';
      const hasValidContextRef = compAction?.contextRef?.source === 'working_memory' && compAction?.contextRef?.position === 1;
      check('target', hasTarget || hasValidContextRef, 'target_first_task_or_context_ref');
      check('entity_name', compAction?.entityName === 'Demo project' || hasValidContextRef, 'entity_demo_project');
      break;
    }
    case 'task-create-multiple': {
      const creates = actions.filter(a => operation(a) === 'task.create');
      check('multiple_tasks', creates.length === 3, 'three_task_create_actions');
      check('entity_name', creates.every(a => folded(a.entityName) === 'viaje'), 'entity_viaje_for_all');
      check('item_titles', ['comprar maleta', 'revisar seguro', 'descargar tiquetes'].every(t => creates.some(a => folded(a.title || a.content).includes(t))), 'all_three_titles_present');
      break;
    }
    case 'task-list-pending': {
      const listAction = actions.find(a => operation(a) === 'task.list');
      check('task_list', Boolean(listAction), 'task_list_operation');
      check('status_pending', listAction?.status === 'pending', 'status_pending');
      break;
    }
    case 'task-create-explicit': {
      const createAction = actions.find(a => operation(a) === 'task.create');
      check('task_create', Boolean(createAction), 'task_create_operation');
      check('task_title', folded(createAction?.title || createAction?.content).includes('llamar al banco'), 'title_llamar_al_banco');
      check('entity_name', createAction?.entityName === 'Finanzas', 'entity_finanzas');
      break;
    }
    case 'reminder-offset-1m': {
      const remAction = actions.find(a => operation(a) === 'reminder.create');
      check('reminder_create', Boolean(remAction), 'reminder_create_operation');
      check('subject', folded(reminderSubject(remAction)).includes('bano'), 'subject_ir_al_bano');
      check('offset_1m', remAction?.schedule?.kind === 'relative_offset' && remAction?.schedule?.offsetMinutes === 1, 'offset_1_minute');
      break;
    }
    case 'reminder-offset-30m': {
      const remAction = actions.find(a => operation(a) === 'reminder.create');
      check('reminder_create', Boolean(remAction), 'reminder_create_operation');
      check('subject', folded(reminderSubject(remAction)).includes('apagar el horno'), 'subject_apagar_el_horno');
      check('offset_30m', remAction?.schedule?.kind === 'relative_offset' && remAction?.schedule?.offsetMinutes === 30, 'offset_30_minutes');
      break;
    }
    case 'reminder-offset-2h': {
      const remAction = actions.find(a => operation(a) === 'reminder.create');
      check('reminder_create', Boolean(remAction), 'reminder_create_operation');
      check('subject', folded(reminderSubject(remAction)).includes('tomar agua'), 'subject_tomar_agua');
      check('offset_120m', remAction?.schedule?.kind === 'relative_offset' && remAction?.schedule?.offsetMinutes === 120, 'offset_120_minutes');
      break;
    }
    case 'reminder-today-explicit-time': {
      const remAction = actions.find(a => operation(a) === 'reminder.create');
      check('reminder_create', Boolean(remAction), 'reminder_create_operation');
      check('subject', folded(reminderSubject(remAction)).includes('tomar la pastilla'), 'subject_tomar_la_pastilla');
      check('day_offset_0', remAction?.schedule?.dayOffset === 0 || (remAction?.schedule?.month === 10 && remAction?.schedule?.day === 8), 'day_offset_today');
      check('clock_20h', remAction?.schedule?.hour === 20 && (remAction?.schedule?.minute ?? 0) === 0, 'clock_8_pm');
      break;
    }
    case 'multi-reminder-same-day': {
      const rems = actions.filter(a => operation(a) === 'reminder.create');
      check('two_reminders', rems.length === 2, 'two_reminder_create_actions');
      check('first_reminder', rems.some(a => folded(reminderSubject(a)).includes('arena') && (a.schedule?.dayOffset === 1 || (a.schedule?.month === 10 && a.schedule?.day === 9)) && a.schedule?.hour === 8), 'arena_at_8am');
      check('second_reminder', rems.some(a => folded(reminderSubject(a)).includes('cemento') && (a.schedule?.dayOffset === 1 || (a.schedule?.month === 10 && a.schedule?.day === 9)) && a.schedule?.hour === 9), 'cemento_at_9am');
      break;
    }
    case 'reminder-advance-notice': {
      const remAction = actions.find(a => operation(a) === 'reminder.create');
      check('reminder_create', Boolean(remAction), 'reminder_create_operation');
      check('subject', folded(reminderSubject(remAction)).includes('reunion'), 'subject_reunion');
      check('schedule_10am', (remAction?.schedule?.dayOffset === 1 || (remAction?.schedule?.month === 10 && remAction?.schedule?.day === 9)) && remAction?.schedule?.hour === 10, 'tomorrow_at_10am');
      check('advance_15m', remAction?.advanceMinutes === 15 || remAction?.deliveryPolicy?.advanceMinutes === 15, 'advance_15_minutes');
      break;
    }
    case 'reminder-recurrence-hourly': {
      const remAction = actions.find(a => operation(a) === 'reminder.create');
      const clarAction = actions.find(a => operation(a) === 'clarification.request');
      check('reminder_create', Boolean(remAction), 'reminder_create_operation');
      check('recurrence_hourly_2', remAction?.recurrence === 'hourly:2', 'recurrence_hourly_2');
      if (clarAction) {
        const replyText = actions.find(a => operation(a) === 'conversation.reply')?.content || '';
        check('subject', folded(clarAction.question || '').includes('agua') || folded(replyText).includes('agua') || folded(reminderSubject(remAction)).includes('agua'), 'subject_tomar_agua');
      } else {
        check('subject', folded(reminderSubject(remAction)).includes('tomar agua'), 'subject_tomar_agua');
      }
      break;
    }
    case 'reminder-recurrence-daily': {
      const remAction = actions.find(a => operation(a) === 'reminder.create');
      check('reminder_create', Boolean(remAction), 'reminder_create_operation');
      check('recurrence_daily', remAction?.recurrence === 'daily', 'recurrence_daily');
      check('clock_7am', remAction?.schedule?.hour === 7 && (remAction?.schedule?.minute ?? 0) === 0, 'clock_7_am');
      check('subject', folded(reminderSubject(remAction)).includes('hacer ejercicio'), 'subject_hacer_ejercicio');
      break;
    }
    case 'calendar-query-next':
      check('calendar_next', ops.includes('calendar.next') || ops.includes('calendar.list') || ops.includes('agenda.read'), 'calendar_next_or_upcoming_read');
      break;
    case 'calendar-create-event': {
      const calAction = actions.find(a => operation(a) === 'calendar.create');
      check('calendar_create', Boolean(calAction), 'calendar_create_operation');
      check('title', folded(calAction?.title || calAction?.content).includes('reunion con el cliente'), 'title_reunion_cliente');
      const isStart4pm = (calAction?.schedule?.dayOffset === 1 || (calAction?.schedule?.month === 10 && calAction?.schedule?.day === 9)) && calAction?.schedule?.hour === 16;
      const isEnd5pm = (calAction?.endSchedule?.dayOffset === 1 || (calAction?.endSchedule?.month === 10 && calAction?.endSchedule?.day === 9)) && calAction?.endSchedule?.hour === 17;
      check('start_schedule', isStart4pm, 'tomorrow_at_4pm');
      check('end_schedule', isEnd5pm, 'tomorrow_at_5pm');
      break;
    }
    case 'calendar-read-tomorrow': {
      const readAction = actions.find(a => ['calendar.list', 'agenda.read'].includes(operation(a)));
      check('calendar_list', Boolean(readAction), 'calendar_list_or_agenda_read_operation');
      check('tomorrow_scope', readAction?.filter === 'tomorrow' || readAction?.scope === 'tomorrow' || readAction?.schedule?.dayOffset === 1 || (readAction?.schedule?.month === 10 && readAction?.schedule?.day === 9), 'tomorrow_scope');
      check('all_day', readAction?.filter === 'tomorrow' || readAction?.scope === 'tomorrow' || readAction?.schedule?.allDay === true || readAction?.schedule?.dayOffset === 1 || (readAction?.schedule?.month === 10 && readAction?.schedule?.day === 9), 'all_day_read');
      break;
    }
    case 'reminder-list-active':
      check('reminder_list', ops.includes('reminder.list'), 'reminder_list_operation');
      break;
    case 'reminder-cancel-single': {
      const cancelAction = actions.find(a => operation(a) === 'reminder.cancel');
      check('reminder_cancel', Boolean(cancelAction), 'reminder_cancel_operation');
      check('target', folded(cancelAction?.target).includes('gotas en los ojos'), 'target_gotas_en_los_ojos');
      break;
    }
    case 'reminder-cancel-ordinal': {
      const cancelAction = actions.find(a => operation(a) === 'reminder.cancel');
      check('reminder_cancel', Boolean(cancelAction), 'reminder_cancel_operation');
      check('target_ordinal', folded(cancelAction?.target).includes('primer') || cancelAction?.contextRef?.position === 1, 'target_first_reminder');
      break;
    }
    case 'mixed-cancel-and-create': {
      const cancelAction = actions.find(a => operation(a) === 'reminder.cancel');
      const createAction = actions.find(a => operation(a) === 'reminder.create');
      check('cancel_gps', Boolean(cancelAction) && folded(cancelAction?.target).includes('gps'), 'cancel_gps_target');
      check('create_pan', Boolean(createAction) && folded(reminderSubject(createAction)).includes('comprar pan'), 'create_comprar_pan');
      const isTomorrow9am = (createAction?.schedule?.dayOffset === 1 && createAction?.schedule?.hour === 9)
        || (createAction?.schedule?.month === 10 && createAction?.schedule?.day === 9 && createAction?.schedule?.hour === 9);
      check('tomorrow_9am', isTomorrow9am, 'tomorrow_at_9am');
      break;
    }
    case 'project-delete-request': {
      const delAction = actions.find(a => ['project.delete', 'entity.delete'].includes(operation(a)));
      check('project_delete', Boolean(delAction), 'delete_project_operation');
      check('target', folded(delAction?.target || delAction?.entityName).includes('archivo sonoro'), 'target_archivo_sonoro');
      check('no_all_scope', delAction?.scope !== 'all', 'scope_not_all');
      break;
    }
    case 'task-update-rename': {
      const updateAction = actions.find(a => operation(a) === 'task.update');
      check('task_update', Boolean(updateAction), 'task_update_operation');
      check('target', folded(updateAction?.target) === 'first task' || updateAction?.contextRef?.position === 1, 'target_first_task');
      check('new_name', folded(updateAction?.newName || updateAction?.title) === 'revisar servidor', 'new_name_revisar_servidor');
      check('entity_name', updateAction?.entityName === 'Demo project', 'entity_demo_project');
      break;
    }
    case 'memory-save-fact': {
      const memAction = actions.find(a => operation(a) === 'memory.save');
      check('memory_save', Boolean(memAction), 'memory_save_operation');
      check('category_fact', memAction?.category === 'fact', 'category_fact');
      check('content', folded(memAction?.content).includes('15 de marzo'), 'content_birthday_march_15');
      break;
    }
    case 'memory-preference-notice': {
      const hasLearningCandidate = (decision.learningCandidates || []).some(c => c.category === 'preference' && (folded(c.topicKey).includes('reminder') || folded(c.topicKey).includes('notice') || folded(c.content).includes('aviso')));
      const hasMemorySave = actions.some(a => operation(a) === 'memory.save' && folded(a.content).includes('aviso'));
      check('ordinary_reply', hasReply || hasMemorySave, 'ordinary_reply_or_memory_save');
      check('preference_candidate', hasLearningCandidate || hasMemorySave, 'preference_candidate_or_memory_save_reminder_notice');
      break;
    }
    case 'rectification-misunderstanding': {
      const listAction = actions.find(a => operation(a) === 'task.list');
      check('task_list', Boolean(listAction), 'task_list_operation');
      check('entity_malta', folded(listAction?.entityName) === 'malta', 'entity_malta');
      check('status_all', listAction?.status === 'all', 'status_all');
      check('no_reminder', !ops.some(op => op.startsWith('reminder.')), 'no_unwanted_reminder');
      break;
    }
    case 'chat-followup-colloquial':
      check('ordinary_reply', hasReply, 'ordinary_reply');
      check('no_operations', nonConversation.length === 0, 'no_operational_side_effects');
      break;
    case 'chat-gratitude':
      check('ordinary_reply', hasReply, 'ordinary_reply');
      check('no_operations', nonConversation.length === 0, 'no_operational_side_effects');
      break;
    case 'security-quoted-command':
      check('ordinary_reply', hasReply, 'ordinary_reply');
      check('no_operations', nonConversation.length === 0, 'no_operational_side_effects');
      check('no_destructive_ops', !ops.some(op => op.includes('delete')), 'no_destructive_operations');
      break;
    case 'time-explicit-noon': {
      const remAction = actions.find(a => operation(a) === 'reminder.create');
      check('reminder_create', Boolean(remAction), 'reminder_create_operation');
      check('subject', folded(reminderSubject(remAction)).includes('almorzar con mama'), 'subject_almorzar_con_mama');
      const isTomorrowNoon = (remAction?.schedule?.dayOffset === 1 || (remAction?.schedule?.month === 10 && remAction?.schedule?.day === 9)) && remAction?.schedule?.hour === 12 && (remAction?.schedule?.minute ?? 0) === 0;
      check('tomorrow_noon', isTomorrowNoon, 'tomorrow_at_noon');
      break;
    }
    case 'time-explicit-midnight': {
      const remAction = actions.find(a => operation(a) === 'reminder.create');
      check('reminder_create', Boolean(remAction), 'reminder_create_operation');
      check('subject', folded(reminderSubject(remAction)).includes('reiniciar el servidor'), 'subject_reiniciar_servidor');
      check('midnight_hour', remAction?.schedule?.hour === 0 && (remAction?.schedule?.minute ?? 0) === 0, 'midnight_hour_0');
      break;
    }
    case 'task-projectless': {
      const createAction = actions.find(a => operation(a) === 'task.create');
      check('task_create', Boolean(createAction), 'task_create_operation');
      check('title', folded(createAction?.title || createAction?.content).includes('comprar pan'), 'title_comprar_pan');
      check('projectless', createAction?.projectless === true, 'projectless_true');
      check('no_entity', !createAction?.entityName, 'no_entity_name');
      break;
    }
    default: throw new Error('Unknown synthetic case');
  }
  return { passed: assertions.every(item => item.passed), assertions, semanticPolicyVersion: SEMANTIC_GRADING_VERSION,
    simulatedReceipt: simulateReceipt(fixture, validation) };
}

/** Fixture-owned lookup/projection only. Never execute tools or claim persistence. */
function simulateReceipt(fixture: EvaluationFixture, validation: EvaluationValidation) {
  if (!validation?.valid) return { source: 'in_memory_fixture_only', effects: [] };
  const decision = (validation.intent || validation.decision)!;
  if (decision.relation) return { source: 'in_memory_fixture_only', effects: [],
    pendingStatus: decision.relation === 'cancel' || decision.decision === 'reject' ? 'cancelled' : 'resumed_draft_only' };
  const effects: SimulatedEffect[] = [];
  for (const action of decision.actions || []) {
    if (operation(action) === 'task.list') {
      const owned = fixture.context.overview.openTasksByEntity?.[action.entityName!] || [];
      const selected = owned.filter(row => row.user_id === fixture.owner
        && (!action.query || folded(row.title).includes(folded(action.query)))
        && (action.status === 'all' || row.status === action.status)).slice(0, action.limit || owned.length);
      effects.push({ operation: 'task.list', rowIds: selected.map(row => row.id),
        projection: selected.map(row => ({ id: row.id,
          ...Object.fromEntries((action.returnFields || []).map(field => [field, Object.hasOwn(row, field) ? row[field] : '[unknown]'])) })) });
    } else if (['entity.delete', 'project.delete', 'reminder.create', 'task.create', 'task.complete', 'task.update', 'task.delete', 'reminder.cancel', 'calendar.create', 'memory.save'].includes(operation(action))) {
      effects.push({ operation: operation(action), state: ['entity.delete', 'project.delete'].includes(operation(action)) && action.scope === 'all' ? 'waiting_for_approval' : 'draft_only', persisted: false });
    } else if (reads.has(operation(action))) effects.push({ operation: operation(action), state: 'fixture_read_only' });
  }
  return { source: 'in_memory_fixture_only', effects };
}

/** Structural review artifact. Never retain freeform replies/errors/model-invented strings.
 * String-valued authority is eligible only when literally present in this fixture.
 */
export function safeDecision(decision: unknown, fixture: EvaluationFixture, secret = '') {
  // Chain drafts contain model strings. They must NOT enlarge the artifact allowlist.
  const known = fixtureStrings(fixtures.find(item => item.id === fixture.id) || fixture);
  const fields = new Set(['domain', 'action', 'operation', 'responseLanguage', 'responseCapability', 'relation',
    'decision', 'selectedCallIds', 'actions', 'actionInputs', 'callId', 'fields', 'query', 'target', 'entityName',
    'contextRef', 'source', 'position', 'scope', 'status', 'returnFields', 'schedule', 'kind', 'year', 'month',
    'day', 'dayOffset', 'hour', 'minute', 'clockMode', 'allDay', 'missingFields', 'profileUpdate', 'sourceQuote',
    'language', 'learningCandidates', 'topicKey', 'category', 'evidence', 'knowledgeRefs', 'answerFromResults', 'content',
    'title', 'newName', 'oldName', 'offsetMinutes', 'recurrence', 'advanceMinutes', 'endSchedule', 'projectless', 'deliveryPolicy', 'advanceNotice']);
  const enums = new Set(['conversation', 'agenda', 'reminder', 'task', 'entity', 'project', 'reply', 'read', 'list',
    'create', 'delete', 'general', 'es', 'en', 'all', 'pending', 'resume', 'cancel', 'approval', 'reject',
    'relative_day_time', 'calendar_date_time', 'local_time', 'inherit_context', 'explicit_24h', 'explicit_pm',
    'explicit_am', 'ambiguous_12h', 'working_memory', 'time', 'main_time', 'description', 'status', 'fact', 'preference',
    'calendar', 'memory', 'complete', 'update', 'save', 'next', 'search', 'forget', 'relative_offset', 'weekday_time',
    'daily', 'hourly', 'weekdays', 'weekly', 'monthly', 'yearly', 'in_progress', 'completed', 'cancelled']);
  function clean(value: unknown): SafeValue {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 525600 ? value : null;
    if (typeof value === 'string') return !(secret && value.includes(secret)) && value.length <= 180
      && (known.has(value) || enums.has(value)) ? value : '[unrecognized]';
    if (Array.isArray(value)) return value.slice(0, 16).map(clean);
    if (!value || typeof value !== 'object') return null;
    return Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key)).map(([key, child]) => [key, clean(child)]));
  }
  return clean(decision);
}
