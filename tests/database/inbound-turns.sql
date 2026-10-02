-- Run after the two Hermes inbox/access migrations in disposable PostgreSQL.
-- Fixtures are scoped to one random thread and rolled back even on success.
\set ON_ERROR_STOP on
begin;
do $$
declare
  thread text := 'hermes-queue-test-' || gen_random_uuid()::text;
  first_turn public.hermes_inbound_turns;
  next_turn public.hermes_inbound_turns;
  expired_turn public.hermes_inbound_turns;
  checkpoint jsonb;
  claimed integer;
begin
  insert into public.hermes_inbound_turns(message_id, thread_id, request)
    values (thread || '-1', thread, '{"original":true}'),
           (thread || '-2', thread, '{}'), (thread || '-3', thread, '{}');
  insert into public.hermes_inbound_turns(message_id, thread_id, request)
    values (thread || '-1', thread, '{"original":false}') on conflict(message_id) do nothing;
  select * into first_turn from public.claim_hermes_inbound_turn(thread);
  assert first_turn.message_id = thread || '-1', 'FIFO claim';
  assert first_turn.request->>'original' = 'true', 'Duplicate must preserve request';
  select count(*) into claimed from public.claim_hermes_inbound_turn(thread);
  assert claimed = 0, 'One active worker per thread';
  assert not public.finish_hermes_inbound_turn(first_turn.id, gen_random_uuid(), 'completed'), 'Wrong owner blocked';
  assert public.renew_hermes_inbound_turn(first_turn.id, first_turn.lease_token), 'Owner can renew';
  assert public.checkpoint_hermes_inbound_turn(first_turn.id, first_turn.lease_token, '{"executionFacts":[{"outcome":"success"}],"confirmation":"Observed"}'), 'Persist facts';
  assert public.checkpoint_hermes_inbound_turn(first_turn.id, first_turn.lease_token, '{"delivery":{"status":"accepted","messageId":"synthetic"}}'), 'Persist delivery';
  select response into checkpoint from public.hermes_inbound_turns where id = first_turn.id;
  assert checkpoint->>'confirmation' = 'Observed' and jsonb_array_length(checkpoint->'executionFacts') = 1, 'Delivery must preserve facts';
  assert public.finish_hermes_inbound_turn(first_turn.id, first_turn.lease_token, 'completed'), 'Owner finishes';
  assert not public.finish_hermes_inbound_turn(first_turn.id, first_turn.lease_token, 'completed'), 'Terminal receipt immutable';
  select * into expired_turn from public.claim_hermes_inbound_turn(thread);
  assert expired_turn.message_id = thread || '-2', 'FIFO after completion';
  update public.hermes_inbound_turns set lease_expires_at = clock_timestamp() - interval '1 second' where id = expired_turn.id;
  select * into next_turn from public.claim_hermes_inbound_turn(thread);
  assert next_turn.message_id = thread || '-3', 'Interrupted turn never replayed';
  assert (select status = 'unknown' from public.hermes_inbound_turns where id = expired_turn.id), 'Interruption recorded';
  assert not public.renew_hermes_inbound_turn(expired_turn.id, expired_turn.lease_token), 'Expired lease fenced';
  assert not has_table_privilege('anon', 'public.users', 'select'), 'User data private';
  assert not has_table_privilege('authenticated', 'public.hermes_inbound_turns', 'select'), 'Inbox private';
  assert not has_function_privilege('anon', 'public.claim_hermes_inbound_turn(text)', 'execute'), 'Queue RPC private';
  assert has_table_privilege('service_role', 'public.users', 'select,insert,update,delete'), 'Backend access preserved';
  assert public.hermes_inbound_queue_version() = 1, 'Readiness version';
end;
$$;
rollback;
