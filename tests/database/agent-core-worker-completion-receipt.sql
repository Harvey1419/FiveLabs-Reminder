-- Previous completion fixtures have published one owned certificate inside this rollback transaction.
do $$
declare row public.hermes_inbound_turns; original jsonb; unrelated uuid;
begin
  select * into row from public.hermes_inbound_turns where status='completed' and completion_lease_token is not null order by sequence_id desc limit 1;
  assert row.id is not null,'Atomic finalizer records the retired owner token';
  assert public.was_completed_hermes_active_turn(row.id,row.completion_lease_token),'Exact retired owner can observe its published completion';
  assert not public.was_completed_hermes_active_turn(row.id,gen_random_uuid()),'Foreign token cannot observe completion';
  assert not public.was_completed_hermes_active_turn(gen_random_uuid(),row.completion_lease_token),'Receipt bound to exact inbound identity';
  assert not public.renew_hermes_inbound_turn(row.id,row.completion_lease_token),'Receipt token never renews the retired lease';
  original:=row.response;
  update public.hermes_inbound_turns set response=jsonb_set(response,'{agentCoreActiveCompletion,baseline,requestId}','"foreign"') where id=row.id;
  assert not public.was_completed_hermes_active_turn(row.id,row.completion_lease_token),'Mismatched certificate identity cannot satisfy observer';
  update public.hermes_inbound_turns set response=original,status='unknown' where id=row.id;
  assert not public.was_completed_hermes_active_turn(row.id,row.completion_lease_token),'Unknown status cannot certify completion';
  update public.hermes_inbound_turns set status='completed' where id=row.id;
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status) values(gen_random_uuid()::text,'legacy-receipt-'||gen_random_uuid()::text,'{}','completed') returning id into unrelated;
  assert not public.was_completed_hermes_active_turn(unrelated,row.completion_lease_token),'Legacy completion without receipt cannot certify typed publication';
  assert not has_function_privilege('anon','public.was_completed_hermes_active_turn(uuid,uuid)','execute'),'Observer RPC private';
  assert not has_column_privilege('authenticated','public.hermes_inbound_turns','completion_lease_token','select'),'Retired receipt key hidden from frontend';
end;
$$;
