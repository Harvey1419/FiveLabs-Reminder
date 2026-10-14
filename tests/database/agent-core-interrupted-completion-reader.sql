-- Exercise the reader against the preceding real accepted cancellation fixture, then roll back everything.
do $$
declare prior public.hermes_inbound_turns; owner public.hermes_inbound_turns; evidence jsonb; before_response jsonb; u uuid;
begin
  select * into prior from public.hermes_inbound_turns where status='completed' and response ? 'agentCoreActiveCompletion' order by sequence_id desc limit 1;
  u:=(prior.response->'agentCoreActiveCompletion'->'baseline'->>'userId')::uuid;
  before_response:=prior.response-'agentCoreActiveCompletion';
  update public.hermes_inbound_turns set status='unknown',response=before_response,completion_lease_token=null where id=prior.id;
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at)
    values('interrupted-reader-'||gen_random_uuid()::text,prior.thread_id,'{}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into owner;
  evidence:=public.read_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id);
  assert evidence->'snapshot'->'prior'->>'id'=prior.id::text,'Reader chooses the interrupted predecessor';
  assert evidence->'snapshot'->'anchor'->>'id'=owner.id::text,'Recovery reads are bound to current owner';
  assert evidence->'baseline'->'input'->>'userText'='Cancela','Captured user input is preserved';
  assert evidence->'manifest'->'entries'->0->>'state'='accepted','Actual accepted delivery ledger supplied';
  assert evidence->'receipts'='[]'::jsonb,'Cancellation carries no inferred task effect';
  assert (select status='unknown' and response=before_response and not response ? 'agentCoreActiveCompletion' from public.hermes_inbound_turns where id=prior.id),'Read does not close or mutate the prior turn';
  assert (select status='running' and lease_token=owner.lease_token from public.hermes_inbound_turns where id=owner.id),'Read never retires current owner';
  assert public.read_hermes_interrupted_active_completion(owner.id,gen_random_uuid(),u,owner.message_id,owner.thread_id) is null,'Wrong nonce denied';
  assert public.read_hermes_interrupted_active_completion(owner.id,owner.lease_token,gen_random_uuid(),owner.message_id,owner.thread_id) is null,'Foreign user cannot read prior evidence';
  assert public.read_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,'foreign',owner.thread_id) is null,'Request mismatch denied';
  assert public.read_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,'foreign') is null,'Thread mismatch denied';
  update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()-interval '1 second' where id=owner.id;
  assert public.read_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id) is null,'Expired current lease denied';
  update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()+interval '120 seconds' where id=owner.id;
  -- The underlying helper must not skip a more inconvenient oldest unknown engine.
  update public.hermes_inbound_turns set response='{}' where id=prior.id;
  assert public.read_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id) is null,'Unknown unsupported engine stays blocked';
  update public.hermes_inbound_turns set status='completed' where id=prior.id;
  assert public.read_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id)='{"absent":true}'::jsonb,'No interrupted predecessor is explicit even with a legacy completed engine';
  assert not has_function_privilege('anon','public.read_hermes_interrupted_active_completion(uuid,uuid,uuid,text,text)','execute'),'Reader hidden from anon';
  assert not has_function_privilege('authenticated','public.read_hermes_interrupted_active_completion(uuid,uuid,uuid,text,text)','execute'),'Reader hidden from authenticated';
  assert has_function_privilege('service_role','public.read_hermes_interrupted_active_completion(uuid,uuid,uuid,text,text)','execute'),'Backend reader callable';
end;
$$;
