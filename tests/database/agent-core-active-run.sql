-- Disposable database only; caller loads schemas/functions inside this transaction.
do $$
#variable_conflict use_variable
declare u uuid := gen_random_uuid(); t text := 'active-bridge-'||gen_random_uuid()::text;
  run_id uuid; owner_row public.hermes_inbound_turns; expected jsonb; receipt jsonb; changed jsonb; action jsonb;
begin
  insert into public.users(id) values(u);
  insert into public.agent_runs(user_id,thread_id,status,kind,context,expires_at)
    values(u,t,'waiting_for_approval','generic_operation','{"timezone":"America/Bogota"}',clock_timestamp()+interval '10 minutes') returning id into run_id;
  insert into public.prepared_actions(run_id,call_id,domain,action,payload) values(run_id,'call-1','task','delete','{"action":"delete"}');
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status) values(t||'-prior',t,'{}','unknown');
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at)
    values(t,t,'{}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into owner_row;
  select public.agent_core_active_snapshot(run_id,(expires_at::text)) into expected from public.agent_runs where id=run_id;
  assert public.claim_hermes_active_run(owner_row.id,owner_row.lease_token,expected,'running','{}') is null,'Prior unknown turn denied';
  update public.hermes_inbound_turns set status='completed' where message_id=t||'-prior';
  update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()-interval '1 second' where id=owner_row.id;
  assert public.claim_hermes_active_run(owner_row.id,owner_row.lease_token,expected,'running','{}') is null,'Expired lease denied';
  update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()+interval '120 seconds' where id=owner_row.id;
  assert public.claim_hermes_active_run(owner_row.id,gen_random_uuid(),expected,'running','{}') is null,'Wrong lease denied';
  assert public.claim_hermes_active_run(owner_row.id,owner_row.lease_token,expected||jsonb_build_object('userId',gen_random_uuid()::text),'running','{}') is null,'Foreign user denied';
  assert public.claim_hermes_active_run(owner_row.id,owner_row.lease_token,expected||'{"threadId":"foreign"}','running','{}') is null,'Foreign thread denied';
  changed := jsonb_set(expected,'{actions,0,payload}','{"action":"delete","target":"changed"}');
  assert public.claim_hermes_active_run(owner_row.id,owner_row.lease_token,changed,'running','{}') is null,'Changed payload denied';
  changed := jsonb_set(expected,'{executionState,context}','{"timezone":"UTC"}');
  assert public.claim_hermes_active_run(owner_row.id,owner_row.lease_token,changed,'running','{}') is null,'Changed temporal context denied';
  changed := jsonb_set(expected,'{executionState,kind}','"entity_destructive_batch"');
  assert public.claim_hermes_active_run(owner_row.id,owner_row.lease_token,changed,'running','{}') is null,'Changed run kind denied';
  changed := jsonb_set(expected,'{actions,0,executionFact}','{"outcome":"unknown"}');
  assert public.claim_hermes_active_run(owner_row.id,owner_row.lease_token,changed,'running','{}') is null,'Changed prior receipt denied';
  update public.hermes_inbound_turns set response='{"agentCoreProductivity":{}}' where id=owner_row.id;
  assert public.claim_hermes_active_run(owner_row.id,owner_row.lease_token,expected,'running','{}') is null,'Other engine denied';
  update public.hermes_inbound_turns set response=null where id=owner_row.id;
  assert public.claim_hermes_active_run(owner_row.id,owner_row.lease_token,expected,'cancelled','{}') is null,'Unconfirmed cancellation denied';
  receipt := public.claim_hermes_active_run(owner_row.id,owner_row.lease_token,expected,'running','{"relation":"approval","decision":"approve_all"}');
  assert receipt is not null and receipt->'snapshot'=expected,'Atomic compare-and-claim';
  assert (select status='running' from public.agent_runs where id=run_id),'Claim state persisted';
  assert (select response->'agentCoreActiveRun'->'snapshot'=expected from public.hermes_inbound_turns where id=owner_row.id),'Start evidence atomic with claim';
  assert public.claim_hermes_active_run(owner_row.id,owner_row.lease_token,expected,'running','{}') is null,'Second claim denied';
  assert public.mutate_hermes_active_run(owner_row.id,owner_row.lease_token,run_id,gen_random_uuid(),'assert','{}') is null,'Foreign claim nonce denied';
  assert public.mutate_hermes_active_run(owner_row.id,owner_row.lease_token,run_id,(receipt->>'claimId')::uuid,'assert','{}')='{}','Live grant validated';
  update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()-interval '1 second' where id=owner_row.id;
  assert public.mutate_hermes_active_run(owner_row.id,owner_row.lease_token,run_id,(receipt->>'claimId')::uuid,'assert','{}') is null,'Expired grant cannot dispatch';
  update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()+interval '120 seconds' where id=owner_row.id;
  action := expected->'actions'->0;
  changed := jsonb_build_object('callId','call-1','expected',action||'{"targetName":"stale"}','updates',jsonb_build_object('status','failed','executionFact',jsonb_build_object('outcome','unknown')));
  assert public.mutate_hermes_active_run(owner_row.id,owner_row.lease_token,run_id,(receipt->>'claimId')::uuid,'action',changed) is null,'Action CAS denied';
  changed := jsonb_set(changed,'{expected}',action);
  assert public.mutate_hermes_active_run(owner_row.id,owner_row.lease_token,run_id,(receipt->>'claimId')::uuid,'action',changed) is not null,'Unknown write fence persisted';
  assert (select response->'agentCoreActiveRun'->'actions'->'call-1'->'execution_fact'->>'outcome'='unknown' from public.hermes_inbound_turns where id=owner_row.id),'Fence checkpointed atomically';
  assert public.mutate_hermes_active_run(owner_row.id,owner_row.lease_token,run_id,(receipt->>'claimId')::uuid,'action',changed) is null,'Repeated stale action mutation denied';
  insert into public.prepared_actions(run_id,call_id,domain,action,payload) values(run_id,'unexpected','task','delete','{}');
  assert public.mutate_hermes_active_run(owner_row.id,owner_row.lease_token,run_id,(receipt->>'claimId')::uuid,'run','{"status":"failed"}') is null,'New action prevents misleading final state';
  delete from public.prepared_actions a where a.run_id=run_id and a.call_id='unexpected';
  assert public.mutate_hermes_active_run(owner_row.id,owner_row.lease_token,run_id,(receipt->>'claimId')::uuid,'run','{"status":"failed"}') is not null,'Known terminal state persisted';
  assert public.mutate_hermes_active_run(owner_row.id,owner_row.lease_token,run_id,(receipt->>'claimId')::uuid,'assert','{}') is null,'Terminal grant cannot dispatch';
  assert public.mutate_hermes_active_run(owner_row.id,owner_row.lease_token,run_id,(receipt->>'claimId')::uuid,'finish','{"success":false}') is not null,'Final receipt persisted';
  assert not (select context ? '_agentCoreClaim' from public.agent_runs where id=run_id),'Grant retired after final receipt';
  assert public.mutate_hermes_active_run(owner_row.id,owner_row.lease_token,run_id,(receipt->>'claimId')::uuid,'finish','{}') is null,'Retired nonce cannot mutate';
  assert not has_function_privilege('anon','public.claim_hermes_active_run(uuid,uuid,jsonb,text,jsonb)','execute'),'Anonymous RPC denied';
  assert not has_function_privilege('authenticated','public.mutate_hermes_active_run(uuid,uuid,uuid,uuid,text,jsonb)','execute'),'Authenticated mutation denied';
  assert has_function_privilege('service_role','public.claim_hermes_active_run(uuid,uuid,jsonb,text,jsonb)','execute'),'Backend claim available';
  assert not (select prosecdef from pg_proc where oid='public.claim_hermes_active_run(uuid,uuid,jsonb,text,jsonb)'::regprocedure),'Claim is security invoker';
  assert not (select prosecdef from pg_proc where oid='public.mutate_hermes_active_run(uuid,uuid,uuid,uuid,text,jsonb)'::regprocedure),'Mutation is security invoker';
end;
$$;
