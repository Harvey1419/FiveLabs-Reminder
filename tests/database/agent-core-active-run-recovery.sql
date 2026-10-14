-- Caller supplies actual queue/run schemas and RPCs inside a disposable rolled-back transaction.
create temporary table active_recovery_fixture (stage text, snapshot jsonb);
do $$
#variable_conflict use_variable
declare u uuid := gen_random_uuid(); t text := 'active-recovery-'||gen_random_uuid()::text;
  prior public.hermes_inbound_turns; current_owner public.hermes_inbound_turns;
  run_id uuid; expected jsonb; claim jsonb; result jsonb; original_response jsonb; unknown_id uuid;
begin
  insert into public.users(id) values(u);
  insert into public.agent_runs(user_id,thread_id,status,kind,expires_at,context)
    values(u,t,'waiting_for_approval','generic_operation',clock_timestamp()+interval '1 hour','{}') returning id into run_id;
  insert into public.prepared_actions(run_id,call_id,domain,action,payload) values(run_id,'a','task','delete','{"action":"delete"}');
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at)
    values(t||'-prior',t,'{}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into prior;
  select public.agent_core_active_snapshot(run_id,to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    into expected from public.agent_runs where id=run_id;
  claim := public.claim_hermes_active_run(prior.id,prior.lease_token,expected,'running','{"relation":"approval","decision":"approve_all"}');
  assert claim is not null,'Recovery source acquired';
  assert public.mutate_hermes_active_run(prior.id,prior.lease_token,run_id,(claim->>'claimId')::uuid,'action',
    jsonb_build_object('callId','a','expected',expected->'actions'->0,'updates',
      jsonb_build_object('status','failed','executionFact',jsonb_build_object('outcome','unknown','success',false)))) is not null,'Recovery write fence persisted';
  update public.hermes_inbound_turns set status='unknown' where id=prior.id returning response into original_response;
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at)
    values(t||'-current',t,'{}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into current_owner;
  result := public.read_hermes_active_run_recovery(current_owner.id,current_owner.lease_token,u,current_owner.message_id,t);
  assert result->'prior'->>'id'=prior.id::text,'Old uncertain turn chosen';
  assert result->'actions'->0->'executionFact'->>'outcome'='unknown','Persisted fence projected';
  assert result->'prior'->'response'=original_response,'Original checkpoint preserved';
  insert into active_recovery_fixture values('claimed',result);
  assert (select status='running' from public.agent_runs where id=run_id),'Recovery does not reopen or close run';
  assert (select response=original_response and status='unknown' from public.hermes_inbound_turns where id=prior.id),'Recovery does not resolve source';
  assert public.read_hermes_active_run_recovery(current_owner.id,gen_random_uuid(),u,current_owner.message_id,t) is null,'Wrong lease denied';
  assert public.read_hermes_active_run_recovery(current_owner.id,current_owner.lease_token,gen_random_uuid(),current_owner.message_id,t) is null,'Foreign user denied';
  assert public.read_hermes_active_run_recovery(current_owner.id,current_owner.lease_token,u,'foreign',t) is null,'Foreign message denied';
  assert public.read_hermes_active_run_recovery(current_owner.id,current_owner.lease_token,u,current_owner.message_id,'foreign') is null,'Foreign thread denied';
  update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()-interval '1 second' where id=current_owner.id;
  assert public.read_hermes_active_run_recovery(current_owner.id,current_owner.lease_token,u,current_owner.message_id,t) is null,'Expired recovery lease denied';
  update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()+interval '120 seconds' where id=current_owner.id;
  -- A later completed foreign-engine turn cannot hide the earlier uncertainty.
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,response)
    values(t||'-newer',t,'{}','completed','{"agentCoreProductivity":{}}');
  -- Make the owner newer than both candidates, as a real subsequent worker would be.
  update public.hermes_inbound_turns set status='completed' where id=current_owner.id;
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at)
    values(t||'-next',t,'{}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into current_owner;
  assert public.read_hermes_active_run_recovery(current_owner.id,current_owner.lease_token,u,current_owner.message_id,t)->'prior'->>'id'=prior.id::text,'Old unknown dominates latest completed';
  update public.hermes_inbound_turns set response=response||'{"agentCoreProductivity":{}}' where id=prior.id;
  assert public.read_hermes_active_run_recovery(current_owner.id,current_owner.lease_token,u,current_owner.message_id,t) is null,'Mixed engines denied';
  update public.hermes_inbound_turns set response=original_response where id=prior.id;
  update public.agent_runs set expires_at=clock_timestamp()-interval '1 hour' where id=run_id;
  assert public.read_hermes_active_run_recovery(current_owner.id,current_owner.lease_token,u,current_owner.message_id,t) is not null,'Expired historical evidence remains readable';
  update public.agent_runs set expires_at=(expected->>'expiresAtIso')::timestamptz,status='failed',context=context-'_agentCoreClaim' where id=run_id;
  update public.hermes_inbound_turns set response=jsonb_set(response,'{agentCoreActiveRun}',
    response->'agentCoreActiveRun'||'{"stage":"final","result":{"success":false,"status":"failed","facts":[{"outcome":"unknown"}]}}') where id=prior.id;
  result := public.read_hermes_active_run_recovery(current_owner.id,current_owner.lease_token,u,current_owner.message_id,t);
  assert result->'prior'->'response'->'agentCoreActiveRun'->>'stage'='final','Final quarantined evidence readable';
  insert into active_recovery_fixture values('final',result);
  update public.hermes_inbound_turns set status='completed' where id=prior.id;
  assert public.read_hermes_active_run_recovery(current_owner.id,current_owner.lease_token,u,current_owner.message_id,t) is null,'Foreign latest engine requires explicit handoff';
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at)
    values(t||'-empty',t||'-empty','{}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into current_owner;
  assert public.read_hermes_active_run_recovery(current_owner.id,current_owner.lease_token,u,current_owner.message_id,current_owner.thread_id)='{"absent":true}','Explicit absence only when no prior turn exists';
  assert not has_function_privilege('anon','public.read_hermes_active_run_recovery(uuid,uuid,uuid,text,text)','execute'),'Anonymous recovery denied';
  assert not has_function_privilege('authenticated','public.read_hermes_active_run_recovery(uuid,uuid,uuid,text,text)','execute'),'Authenticated recovery denied';
  assert has_function_privilege('service_role','public.read_hermes_active_run_recovery(uuid,uuid,uuid,text,text)','execute'),'Backend recovery allowed';
  assert (select not prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='public.read_hermes_active_run_recovery(uuid,uuid,uuid,text,text)'::regprocedure),'Recovery invoker and empty search path';
end;
$$;
select 'ACTIVE_RECOVERY_FIXTURES:'||jsonb_agg(jsonb_build_object('stage',stage,'snapshot',snapshot))::text from active_recovery_fixture;
