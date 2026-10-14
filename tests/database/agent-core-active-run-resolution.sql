-- Caller loads actual queue/run/RPC DDL in a rolled-back local transaction.
do $$
#variable_conflict use_variable
declare u uuid := gen_random_uuid(); t text := 'active-resolution-'||gen_random_uuid()::text;
  prior public.hermes_inbound_turns; owner_row public.hermes_inbound_turns; run_id uuid;
  expected jsonb; claim jsonb; source jsonb; resolution jsonb; changed jsonb; original jsonb;
begin
  insert into public.users(id) values(u);
  insert into public.agent_runs(user_id,thread_id,status,kind,context,expires_at)
    values(u,t,'waiting_for_approval','generic_operation','{}',clock_timestamp()+interval '1 hour') returning id into run_id;
  insert into public.prepared_actions(run_id,call_id,domain,action,payload) values(run_id,'a','task','delete','{"action":"delete"}');
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at)
    values(t||'-prior',t,'{}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into prior;
  select public.agent_core_active_snapshot(run_id,to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) into expected from public.agent_runs where id=run_id;
  claim := public.claim_hermes_active_run(prior.id,prior.lease_token,expected,'running','{"relation":"approval","decision":"approve_all"}');
  assert public.mutate_hermes_active_run(prior.id,prior.lease_token,run_id,(claim->>'claimId')::uuid,'action',
    jsonb_build_object('callId','a','expected',expected->'actions'->0,'updates',jsonb_build_object('status','failed',
      'executionFact',jsonb_build_object('success',false,'outcome','unknown')))) is not null,'Resolution fixture fenced';
  update public.hermes_inbound_turns set status='unknown' where id=prior.id returning response into original;
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at)
    values(t||'-current',t,'{}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into owner_row;
  source := public.read_hermes_active_run_recovery(owner_row.id,owner_row.lease_token,u,owner_row.message_id,t);
  -- SQL isolation tests use placeholders for host SHA fingerprints; emitted round-trip verifies real host hashes separately.
  resolution := jsonb_build_object('version',1,'kind','active_run_handoff','grantsExecution',false,'userId',u::text,
    'runId',prior.id::text,'requestId',prior.message_id,'threadId',t,'activeRunId',run_id::text,'claimId',claim->>'claimId',
    'sourceFingerprint',repeat('a',64),'snapshotFingerprint',repeat('b',64),'source',source,'runStatus','failed',
    'baseline',jsonb_build_object('userId',u::text),'conversation',jsonb_build_object('userId',u::text,'handledRequestIds',jsonb_build_array(prior.message_id)),
    'effects',jsonb_build_array(jsonb_build_object('userId',u::text,'activeRunId',run_id::text,'callId','a','actionFingerprint',repeat('c',64),
      'evidenceId','trusted-no-effect','coversCompanions',true,'outcome','no_effect','item',null)),
    'delivery',jsonb_build_object('userId',u::text,'inboundRunId',prior.id::text,'sourceFingerprint',repeat('a',64),
      'evidenceId','trusted-no-send','outcome','not_sent','messageIds','[]'::jsonb));
  assert not public.resolve_hermes_active_run(owner_row.id,gen_random_uuid(),source,resolution),'Wrong lease denied';
  assert not public.resolve_hermes_active_run(owner_row.id,owner_row.lease_token,source,'{}'),'Malformed resolution denied';
  assert not public.resolve_hermes_active_run(owner_row.id,owner_row.lease_token,source,resolution||'{"grantsExecution":true}'),'Effect authority denied';
  assert not public.resolve_hermes_active_run(owner_row.id,owner_row.lease_token,source,resolution||'{"runStatus":"running"}'),'Reopening denied';
  assert not public.resolve_hermes_active_run(owner_row.id,owner_row.lease_token,source,resolution||jsonb_build_object('userId',gen_random_uuid()::text)),'Foreign user denied';
  assert not public.resolve_hermes_active_run(owner_row.id,owner_row.lease_token,source,jsonb_set(resolution,'{effects}','[]')),'Missing receipt denied';
  changed := jsonb_set(resolution,'{effects}',(resolution->'effects')||(resolution->'effects'));
  assert not public.resolve_hermes_active_run(owner_row.id,owner_row.lease_token,source,changed),'Duplicate receipt denied';
  changed := jsonb_set(resolution,'{effects,0,coversCompanions}','false');
  assert not public.resolve_hermes_active_run(owner_row.id,owner_row.lease_token,source,changed),'Unconfirmed companion denied';
  changed := jsonb_set(resolution,'{delivery,outcome}','"accepted"');
  assert not public.resolve_hermes_active_run(owner_row.id,owner_row.lease_token,source,changed),'Missing accepted sender receipt denied';
  update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()-interval '1 second' where id=owner_row.id;
  assert not public.resolve_hermes_active_run(owner_row.id,owner_row.lease_token,source,resolution),'Expired owner denied';
  update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()+interval '120 seconds' where id=owner_row.id;
  update public.hermes_inbound_turns set response=response||'{"changed":true}' where id=prior.id;
  assert not public.resolve_hermes_active_run(owner_row.id,owner_row.lease_token,source,resolution),'Whole response CAS enforced';
  update public.hermes_inbound_turns set response=original where id=prior.id;
  update public.prepared_actions a set payload='{"changed":true}' where a.run_id=run_id;
  assert not public.resolve_hermes_active_run(owner_row.id,owner_row.lease_token,source,resolution),'Prepared payload CAS enforced';
  update public.prepared_actions a set payload='{"action":"delete"}' where a.run_id=run_id;
  update public.agent_runs set context=context||'{"changed":true}' where id=run_id;
  assert not public.resolve_hermes_active_run(owner_row.id,owner_row.lease_token,source,resolution),'Run context CAS enforced';
  update public.agent_runs set context=context-'changed' where id=run_id;
  assert public.resolve_hermes_active_run(owner_row.id,owner_row.lease_token,source,resolution),'Owned receipt closure accepted';
  assert (select response-'agentCoreActiveResolution'=original and status='completed' from public.hermes_inbound_turns where id=prior.id),'Original evidence preserved and turn closed atomically';
  assert (select status='failed' and not context ? '_agentCoreClaim' from public.agent_runs where id=run_id),'Run closed and claim retired';
  assert (select status='failed' and execution_fact->>'outcome'='unknown' from public.prepared_actions a where a.run_id=run_id),'Original action fence remains auditable';
  assert not public.resolve_hermes_active_run(owner_row.id,owner_row.lease_token,source,resolution),'Duplicate closure denied';
  assert not has_function_privilege('anon','public.resolve_hermes_active_run(uuid,uuid,jsonb,jsonb)','execute'),'Anonymous closure denied';
  assert not has_function_privilege('authenticated','public.resolve_hermes_active_run(uuid,uuid,jsonb,jsonb)','execute'),'Authenticated closure denied';
  assert has_function_privilege('service_role','public.resolve_hermes_active_run(uuid,uuid,jsonb,jsonb)','execute'),'Backend closure allowed';
  assert (select not prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='public.resolve_hermes_active_run(uuid,uuid,jsonb,jsonb)'::regprocedure),'Invoker closure and empty search path';
end;
$$;
