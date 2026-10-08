import { fixtureStrings, fixtures, REMINDER_EXPECTATIONS, SEMANTIC_GRADING_VERSION } from './fixtures.js';
import { mergePendingSchedule, resolveTypedSchedule } from '../../../src/agent/orchestration/typed-schedule.js';

const reads = new Set(['agenda.read', 'task.list', 'reminder.list', 'calendar.list', 'calendar.search', 'calendar.next', 'memory.list', 'memory.search']);
const operation = action => `${action.domain}.${action.action}`;
const folded = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Limited presentation equivalence only; no fuzzy subject inference or model judging.
const subjectKey = text => folded(text).replace(/[.,:;!?¿¡"'“”‘’()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
const reminderSubject = action => typeof action?.content === 'string' && action.content.trim()
  ? action.content : action?.title;

function resolvedParts(schedule, fixture) {
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

function subjectAssertion(check, fixture, action) {
  const expected = REMINDER_EXPECTATIONS[fixture.id];
  const actual = reminderSubject(action);
  const matched = typeof actual === 'string' && expected.subjectAliases.some(alias => subjectKey(alias) === subjectKey(actual));
  check('reminder_subject', matched, matched ? 'declared_owned_subject_equivalence' : 'subject_not_in_declared_aliases', matched ? 'passed' : 'unresolved');
}

function dateAssertions(check, fixture, schedule) {
  const actual = resolvedParts(schedule, fixture);
  check('typed_temporal_resolution', actual.resolved.valid, 'actual_typed_resolver_with_owned_anchor');
  for (const [field, value] of Object.entries(REMINDER_EXPECTATIONS[fixture.id].date))
    check(`date_${field}`, actual.parts?.[field] === value, 'resolved_owned_calendar_component');
  check('no_explicit_all_day', schedule?.allDay !== true, 'reminder_requires_clock_not_all_day');
  return actual;
}

function completeClockAssertions(check, fixture, schedule) {
  const actual = dateAssertions(check, fixture, schedule);
  const expected = REMINDER_EXPECTATIONS[fixture.id].clock;
  check('clock_hour', actual.parts?.hour === expected.hour, 'resolved_requested_local_hour');
  check('clock_minute', actual.parts?.minute === expected.minute, 'resolved_requested_minute_including_inferred_zero');
  check('clock_mode', schedule?.clockMode == null || ['explicit_24h', 'explicit_pm'].includes(schedule.clockMode), 'explicit_unambiguous_pm_or_backend_24h');
}

/** Independent semantic assertions, not generated acknowledgements as execution proof. */
export function gradeDecision(fixture, validation) {
  const assertions = [];
  const check = (id, passed, reason, outcome) => assertions.push({ id, passed: Boolean(passed), reason,
    ...(outcome ? { outcome } : {}) });
  check('canonical_valid', validation?.valid, validation?.valid ? 'accepted_by_actual_validator' : 'rejected_by_actual_validator');
  const decision = validation?.intent || validation?.decision || {};
  const actions = decision.actions || [];
  const ops = actions.map(operation);
  const nonConversation = actions.filter(action => !['conversation', 'clarification'].includes(action.domain));
  const task = actions.find(action => operation(action) === 'task.list');
  const reminder = actions.find(action => operation(action) === 'reminder.create');
  const schedule = reminder?.schedule || {};
  const missingTime = reminder?.missingFields?.some(field => ['time', 'main_time'].includes(field));
  const hasReply = actions.some(action => operation(action) === 'conversation.reply' && typeof action.content === 'string' && action.content.trim());
  const allowed = new Set(fixture.wire.actions?.map(action => action.operation) || []);
  if (fixture.id === 'destructive-request') allowed.add('project.delete');
  check('no_extra_side_effects', !nonConversation.some(action => !allowed.has(operation(action))), 'only_requested_operations');
  const expectedCount = (fixture.wire.actions || []).filter(action => !String(action.operation).startsWith('conversation.')).length;
  check('requested_operation_count', nonConversation.length === expectedCount, 'no_duplicate_or_extra_operational_actions');
  check('clarification_scope', !actions.some(action => action.domain === 'clarification')
    || ['missing-time', 'ampm-ambiguity', 'english-missing-time'].includes(fixture.id), 'clarification_only_for_pending_missing_data');
  switch (fixture.id) {
    case 'greeting':
      check('ordinary_reply', hasReply, 'natural_reply_without_operational_evidence');
      check('no_operations', nonConversation.length === 0, 'no_social_side_effects');
      break;
    case 'personal-recall':
      check('personal_fact', actions.some(action => folded(action.content).includes('luna')) || decision.knowledgeRefs?.includes('pk_0123456789ab_1'), 'known_owned_dog_fact');
      check('no_operations', nonConversation.length === 0, 'personal_recall_does_not_require_live_actions');
      check('no_operational_refs', actions.every(action => !action.evidenceRefs), 'personal_not_operational_history');
      break;
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
      check('owned_call', inputs.length === 1 && inputs[0].callId === 'call-1', 'only_owned_prepared_call');
      const delta = inputs[0]?.fields.schedule;
      const parent = fixture.activeRun?.preparedActions?.find(action => action.call_id === 'call-1')?.payload;
      subjectAssertion(check, fixture, { ...parent, ...inputs[0]?.fields });
      dateAssertions(check, fixture, mergePendingSchedule(parent?.schedule, delta));
      check('clock_hour', delta?.hour === 4, 'neutral_4_45_hour');
      check('clock_minute', delta?.minute === 45, 'neutral_4_45_minute');
      check('unresolved_ampm', delta?.clockMode === 'ambiguous_12h', 'do_not_assume_am_pm');
      check('no_date_reset', ['local_time', 'inherit_context'].includes(delta?.kind)
        || delta?.kind === 'relative_day_time' && delta.dayOffset === 1
        || delta?.kind === 'calendar_date_time' && delta.year === 2026 && delta.month === 10 && delta.day === 9,
      'merge_into_original_tomorrow_draft');
      break;
    }
    case 'reminder-time': {
      check('resume', decision.relation === 'resume', 'resume_existing_draft');
      const input = decision.actionInputs?.find(item => item.callId === 'call-1');
      const delta = input?.fields.schedule;
      check('owned_call', Boolean(input) && decision.actionInputs.length === 1, 'only_prepared_call_1');
      const parent = fixture.activeRun?.preparedActions?.find(action => action.call_id === 'call-1')?.payload;
      subjectAssertion(check, fixture, { ...parent, ...input?.fields });
      completeClockAssertions(check, fixture, mergePendingSchedule(parent?.schedule, delta));
      break;
    }
    case 'ampm-ambiguity':
      subjectAssertion(check, fixture, reminder);
      dateAssertions(check, fixture, schedule);
      check('ambiguous_clock', schedule.hour === 3 && schedule.clockMode === 'ambiguous_12h', 'no_assumed_am_pm');
      check('clock_minute', (schedule.minute ?? 0) === REMINDER_EXPECTATIONS[fixture.id].clock.minute, 'typed_inferred_whole_hour');
      check('pending_ambiguity', missingTime || schedule.clockMode === 'ambiguous_12h', 'backend_may_infer_clarification');
      check('date_scope', schedule.dayOffset === 1, 'tomorrow_preserved');
      break;
    case 'dated-reminder':
      subjectAssertion(check, fixture, reminder);
      completeClockAssertions(check, fixture, schedule);
      break;
    case 'second-description':
      check('owned_target', folded(task?.query) === 'second task', 'known_second_task_title_filter');
      check('owned_container', task?.entityName === 'Demo project', 'owned_demo_project');
      check('permitted_selection', !task?.contextRef, 'task_list_does_not_allow_contextref');
      check('projection', task?.returnFields?.length === 1 && task.returnFields[0] === 'description', 'actual_description_field_not_notes');
      check('status', ['all', 'pending'].includes(task?.status), 'known_task_status');
      break;
    case 'full-projection':
      check('owned_container', task?.entityName === 'Demo project', 'owned_project');
      check('all_statuses', task?.status === 'all', 'unfiltered_status');
      check('no_title_subset', !task?.query, 'all_project_titles');
      check('no_limit_subset', !task?.limit, 'complete_fixture_rows');
      check('permitted_selection', !task?.contextRef, 'task_list_does_not_allow_contextref');
      check('projection', task?.returnFields?.length === 2 && ['description', 'status'].every(field => task.returnFields.includes(field)), 'both_actual_fields');
      break;
    case 'quoted-agenda': {
      check('live_read', ops.includes('agenda.read'), 'current_agenda_requires_read');
      check('read_only', ops.every(op => reads.has(op) || op === 'conversation.reply'), 'quoted_deletion_has_no_authority');
      const date = actions.find(action => operation(action) === 'agenda.read')?.schedule;
      check('today', date?.kind === 'calendar_date_time' && date.year === 2026 && date.month === 10 && date.day === 8 && date.allDay === true, 'explicit_anchored_date_not_query');
      break;
    }
    case 'lasting-language-and-fact':
      check('language', decision.responseLanguage === 'en', 'english_response');
      check('durable_language', (fixture.context.profileLanguage || fixture.context.language) === 'en' || decision.profileUpdate?.language === 'en'
        && fixture.text.includes(decision.profileUpdate.sourceQuote)
        && folded(decision.profileUpdate.sourceQuote).includes('from now on'), 'current_owned_lasting_quote_or_already_saved');
      check('independent_dog_fact', fixture.context.memoryHints.includes('Luna') || decision.learningCandidates?.some(candidate =>
        candidate.category === 'fact' && folded(candidate.content).includes('luna') && fixture.text.includes(candidate.evidence)), 'retain_independent_fact_without_requiring_redundant_update');
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
    default: throw new Error('Unknown synthetic case');
  }
  return { passed: assertions.every(item => item.passed), assertions, semanticPolicyVersion: SEMANTIC_GRADING_VERSION,
    simulatedReceipt: simulateReceipt(fixture, validation) };
}

/** Fixture-owned lookup/projection only. Never execute tools or claim persistence. */
function simulateReceipt(fixture, validation) {
  if (!validation?.valid) return { source: 'in_memory_fixture_only', effects: [] };
  const decision = validation.intent || validation.decision;
  if (decision.relation) return { source: 'in_memory_fixture_only', effects: [],
    pendingStatus: decision.relation === 'cancel' || decision.decision === 'reject' ? 'cancelled' : 'resumed_draft_only' };
  const effects = [];
  for (const action of decision.actions || []) {
    if (operation(action) === 'task.list') {
      const owned = fixture.context.overview.openTasksByEntity?.[action.entityName] || [];
      const selected = owned.filter(row => row.user_id === fixture.owner
        && (!action.query || folded(row.title).includes(folded(action.query)))
        && (action.status === 'all' || row.status === action.status)).slice(0, action.limit || owned.length);
      effects.push({ operation: 'task.list', rowIds: selected.map(row => row.id),
        projection: selected.map(row => ({ id: row.id,
          ...Object.fromEntries((action.returnFields || []).map(field => [field, Object.hasOwn(row, field) ? row[field] : '[unknown]'])) })) });
    } else if (['entity.delete', 'project.delete', 'reminder.create'].includes(operation(action))) {
      effects.push({ operation: operation(action), state: action.domain === 'reminder' ? 'draft_only' : 'waiting_for_approval', persisted: false });
    } else if (reads.has(operation(action))) effects.push({ operation: operation(action), state: 'fixture_read_only' });
  }
  return { source: 'in_memory_fixture_only', effects };
}

/** Structural review artifact. Never retain freeform replies/errors/model-invented strings.
 * String-valued authority is eligible only when literally present in this fixture.
 */
export function safeDecision(decision, fixture, secret = '') {
  // Chain drafts contain model strings. They must NOT enlarge the artifact allowlist.
  const known = fixtureStrings(fixtures.find(item => item.id === fixture.id) || fixture);
  const fields = new Set(['domain', 'action', 'operation', 'responseLanguage', 'responseCapability', 'relation',
    'decision', 'selectedCallIds', 'actions', 'actionInputs', 'callId', 'fields', 'query', 'target', 'entityName',
    'contextRef', 'source', 'position', 'scope', 'status', 'returnFields', 'schedule', 'kind', 'year', 'month',
    'day', 'dayOffset', 'hour', 'minute', 'clockMode', 'allDay', 'missingFields', 'profileUpdate', 'sourceQuote',
    'language', 'learningCandidates', 'topicKey', 'category', 'evidence', 'knowledgeRefs', 'answerFromResults', 'content']);
  const enums = new Set(['conversation', 'agenda', 'reminder', 'task', 'entity', 'project', 'reply', 'read', 'list',
    'create', 'delete', 'general', 'es', 'en', 'all', 'pending', 'resume', 'cancel', 'approval', 'reject',
    'relative_day_time', 'calendar_date_time', 'local_time', 'inherit_context', 'explicit_24h', 'explicit_pm',
    'explicit_am', 'ambiguous_12h', 'working_memory', 'time', 'main_time', 'description', 'status', 'fact', 'preference']);
  function clean(value) {
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
