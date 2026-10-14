-- Run in disposable PostgreSQL after inbound queue and resolution migrations.
-- All fixtures and writes are rolled back.
\set ON_ERROR_STOP on
begin;
do $$
declare
  thread text := 'resolution-test-' || gen_random_uuid()::text;
  target public.hermes_inbound_turns; owner_turn public.hermes_inbound_turns;
  outsider public.hermes_inbound_turns; future_turn public.hermes_inbound_turns;
  legacy public.hermes_inbound_turns; resolution jsonb; before_response jsonb;
begin
  insert into public.hermes_inbound_turns(message_id, thread_id, request, status, response)
    values (thread || '-target', thread, '{}', 'unknown', '{"agentCore":{"version":2,"userId":"fixture-owner"},"delivery":{"status":"unknown"}}') returning * into target;
  insert into public.hermes_inbound_turns(message_id, thread_id, request, status, response)
    values (thread || '-legacy', thread, '{}', 'completed', '{"executionFacts":[],"delivery":{"status":"accepted","messageId":"legacy-id"}}') returning * into legacy;
  insert into public.hermes_inbound_turns(message_id, thread_id, request, status, lease_token, lease_expires_at)
    values (thread || '-owner', thread, '{}', 'running', gen_random_uuid(), clock_timestamp() + interval '120 seconds') returning * into owner_turn;
  insert into public.hermes_inbound_turns(message_id, thread_id, request, status, response)
    values (thread || '-future', thread, '{}', 'unknown', target.response) returning * into future_turn;
  insert into public.hermes_inbound_turns(message_id, thread_id, request, status, response)
    values (thread || '-outsider', thread || '-other', '{}', 'unknown', target.response) returning * into outsider;
  resolution := jsonb_build_object('version', 1, 'kind', 'reconciliation', 'runId', target.id::text,
    'requestId', target.message_id, 'threadId', thread, 'userId', 'fixture-owner',
    'sourceFingerprint', repeat('a',64), 'conversation', jsonb_build_object('userId','fixture-owner','handledRequestIds',jsonb_build_array(target.message_id)));
  assert not public.resolve_hermes_prior_turn(owner_turn.id, gen_random_uuid(), target.id, target.response, resolution), 'Wrong lease blocked';
  assert not public.resolve_hermes_prior_turn(owner_turn.id, owner_turn.lease_token, outsider.id, outsider.response, resolution), 'Foreign thread blocked';
  assert not public.resolve_hermes_prior_turn(owner_turn.id, owner_turn.lease_token, future_turn.id, future_turn.response, resolution), 'Future sequence blocked';
  assert not public.resolve_hermes_prior_turn(owner_turn.id, owner_turn.lease_token, target.id, '{}', resolution), 'Changed source CAS blocked';
  assert not public.resolve_hermes_prior_turn(owner_turn.id, owner_turn.lease_token, target.id, target.response,
    resolution || '{"userId":"foreign"}'), 'Owner mismatch blocked';
  assert not public.resolve_hermes_prior_turn(owner_turn.id, owner_turn.lease_token, target.id, target.response,
    resolution || '{"kind":"invalid"}'), 'Invalid resolution kind blocked';
  update public.hermes_inbound_turns set response = target.response || '{"agentCoreProductivity":{"version":1}}' where id = target.id;
  assert not public.resolve_hermes_prior_turn(owner_turn.id, owner_turn.lease_token, target.id,
    target.response || '{"agentCoreProductivity":{"version":1}}', resolution), 'Mixed effects cannot use reminder-only reconciliation';
  update public.hermes_inbound_turns set response = target.response where id = target.id;
  update public.hermes_inbound_turns set response = target.response || '{"agentCoreActiveRun":{"version":1}}' where id = target.id;
  assert not public.resolve_hermes_prior_turn(owner_turn.id, owner_turn.lease_token, target.id,
    target.response || '{"agentCoreActiveRun":{"version":1}}', resolution), 'Active-run effects cannot use reminder-only reconciliation';
  update public.hermes_inbound_turns set response = target.response where id = target.id;
  assert public.resolve_hermes_prior_turn(owner_turn.id, owner_turn.lease_token, target.id, target.response, resolution), 'Atomic resolution';
  select response into before_response from public.hermes_inbound_turns where id = target.id;
  assert before_response->'agentCore' = target.response->'agentCore' and before_response->'delivery' = target.response->'delivery', 'Original evidence preserved';
  assert (select status = 'completed' from public.hermes_inbound_turns where id = target.id), 'Unknown turn closed';
  assert not public.resolve_hermes_prior_turn(owner_turn.id, owner_turn.lease_token, target.id, target.response, resolution), 'Duplicate closure blocked';
  resolution := resolution || jsonb_build_object('kind','legacy_handoff','runId',legacy.id::text,'requestId',legacy.message_id,
    'conversation',jsonb_build_object('userId','fixture-owner','handledRequestIds',jsonb_build_array(legacy.message_id)));
  update public.hermes_inbound_turns set response = legacy.response || '{"agentCoreProductivity":{"version":1}}' where id = legacy.id;
  assert not public.resolve_hermes_prior_turn(owner_turn.id, owner_turn.lease_token, legacy.id,
    legacy.response || '{"agentCoreProductivity":{"version":1}}', resolution), 'Mixed checkpoint cannot masquerade as legacy handoff';
  update public.hermes_inbound_turns set response = legacy.response where id = legacy.id;
  update public.hermes_inbound_turns set response = legacy.response || '{"agentCoreActiveRun":{"version":1}}' where id = legacy.id;
  assert not public.resolve_hermes_prior_turn(owner_turn.id, owner_turn.lease_token, legacy.id,
    legacy.response || '{"agentCoreActiveRun":{"version":1}}', resolution), 'Active-run checkpoint cannot masquerade as legacy handoff';
  update public.hermes_inbound_turns set response = legacy.response where id = legacy.id;
  assert public.resolve_hermes_prior_turn(owner_turn.id, owner_turn.lease_token, legacy.id, legacy.response, resolution), 'Legacy handoff marker';
  update public.hermes_inbound_turns set lease_expires_at = clock_timestamp() - interval '1 second' where id = owner_turn.id;
  assert not public.resolve_hermes_prior_turn(owner_turn.id, owner_turn.lease_token, future_turn.id, future_turn.response, resolution), 'Expired lease blocked';
  assert not has_function_privilege('anon', 'public.resolve_hermes_prior_turn(uuid,uuid,uuid,jsonb,jsonb)', 'execute'), 'RPC private';
  assert not has_function_privilege('authenticated', 'public.resolve_hermes_prior_turn(uuid,uuid,uuid,jsonb,jsonb)', 'execute'), 'Authenticated role has no resolution authority';
  assert has_function_privilege('service_role', 'public.resolve_hermes_prior_turn(uuid,uuid,uuid,jsonb,jsonb)', 'execute'), 'Backend retains access';
end;
$$;
rollback;
