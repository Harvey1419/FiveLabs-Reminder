-- Runs inside the caller's rolled-back local transaction.
do $$
#variable_conflict use_variable
declare u uuid:=gen_random_uuid(); t text:='baseline-'||gen_random_uuid()::text; r uuid; p public.hermes_inbound_turns;
  older public.hermes_inbound_turns; candidate jsonb; receipt jsonb; payload jsonb; expected jsonb; claim jsonb; recovery public.hermes_inbound_turns; source jsonb;
begin
  insert into public.users(id) values(u);
  insert into public.agent_runs(user_id,thread_id,status,kind,context,expires_at) values(u,t,'waiting_for_approval','generic_operation','{}',clock_timestamp()+interval '1 hour') returning id into r;
  insert into public.prepared_actions(run_id,call_id,domain,action,payload) values(r,'a','task','delete','{}');
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at)
    values(t,t,'{}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into p;
  payload:=jsonb_build_object('userId',u::text,'activeRunId',r::text);
  assert public.access_hermes_owned_baseline(p.id,gen_random_uuid(),'candidate',payload) is null,'Wrong private lease denied';
  assert public.access_hermes_owned_baseline(p.id,p.lease_token,'candidate',payload||jsonb_build_object('userId',gen_random_uuid()::text)) is null,'Foreign user denied';
  candidate:=public.access_hermes_owned_baseline(p.id,p.lease_token,'candidate',payload);
  assert candidate->'prior'='null'::jsonb,'Genesis explicitly requires no previous queue row';
  payload:=payload||jsonb_build_object('candidate',candidate,'candidateFingerprint',repeat('a',64),'conversation',
    jsonb_build_object('userId',u::text,'history','[]'::jsonb,'tasks','[]'::jsonb,'reminders','[]'::jsonb,'events','[]'::jsonb,'handledRequestIds','[]'::jsonb));
  assert public.access_hermes_owned_baseline(p.id,p.lease_token,'capture',jsonb_set(payload,'{candidate,sequenceId}','0')) is null,'Candidate full CAS required';
  assert public.access_hermes_owned_baseline(p.id,p.lease_token,'capture',jsonb_set(payload,'{conversation,userId}',to_jsonb(gen_random_uuid()::text))) is null,'Conversation owner required';
  receipt:=public.access_hermes_owned_baseline(p.id,p.lease_token,'capture',payload);
  assert receipt->'candidate'=candidate,'Exact candidate frozen';
  assert (select response->'agentCoreBaseline'->>'baselineId'=receipt->>'id' from public.hermes_inbound_turns where id=p.id),'Marker and receipt committed atomically';
  assert public.access_hermes_owned_baseline(p.id,p.lease_token,'capture',payload) is null,'Second capture forbidden';
  select public.agent_core_active_snapshot(r,to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) into expected from public.agent_runs where id=r;
  claim:=public.claim_hermes_active_run(p.id,p.lease_token,expected,'cancelled','{"relation":"cancel"}');
  assert claim is not null,'Active-run claim preserves valid baseline namespace';
  assert (select response ? 'agentCoreBaseline' from public.hermes_inbound_turns where id=p.id),'Claim retains baseline marker';
  perform public.mutate_hermes_active_run(p.id,p.lease_token,r,(claim->>'claimId')::uuid,'action',jsonb_build_object('callId','a','expected',expected->'actions'->0,'updates','{"status":"skipped"}'::jsonb));
  perform public.mutate_hermes_active_run(p.id,p.lease_token,r,(claim->>'claimId')::uuid,'finish','{"success":false,"status":"cancelled"}');
  update public.hermes_inbound_turns set status='unknown' where id=p.id;
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at)
    values(t||'-recover',t,'{}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into recovery;
  source:=public.read_hermes_active_run_recovery(recovery.id,recovery.lease_token,u,recovery.message_id,t);
  assert public.access_hermes_owned_baseline(recovery.id,recovery.lease_token,'read',jsonb_build_object('expected',source))=receipt,'Recovery reads actual immutable baseline';
  assert public.access_hermes_owned_baseline(recovery.id,recovery.lease_token,'read',jsonb_build_object('expected',jsonb_set(source,'{prior,response,changed}','true'))) is null,'Whole recovery source CAS required';
  assert public.access_hermes_owned_baseline(p.id,p.lease_token,'candidate',payload) is null,'Retired capture owner denied';
  assert not has_table_privilege('service_role','public.hermes_owned_baselines','update'),'Backend cannot edit baseline';
  assert not has_table_privilege('service_role','public.hermes_owned_baselines','delete'),'Backend cannot erase baseline directly';
  assert not has_table_privilege('authenticated','public.hermes_owned_baselines','select'),'Frontend baseline hidden';
  assert not has_function_privilege('anon','public.access_hermes_owned_baseline(uuid,uuid,text,jsonb)','execute'),'RPC private';
  assert (select relrowsecurity from pg_class where oid='public.hermes_owned_baselines'::regclass),'Baseline RLS enabled';
  -- Queue continuity gates before capture: latest completed is selected; any older unresolved state blocks it.
  t:=t||'-history';
  insert into public.agent_runs(user_id,thread_id,status,kind,context,expires_at) values(u,t,'waiting_for_approval','generic_operation','{}',clock_timestamp()+interval '1 hour') returning id into r;
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,response) values(t||'-old',t,'{}','completed','{"retained":true}') returning * into older;
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at) values(t,t,'{}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into p;
  payload:=jsonb_build_object('userId',u::text,'activeRunId',r::text);
  candidate:=public.access_hermes_owned_baseline(p.id,p.lease_token,'candidate',payload);
  assert candidate->'prior'->>'id'=older.id::text and candidate->'prior'->'response'='{"retained":true}'::jsonb,'Exact latest completed source returned, never fabricated';
  update public.hermes_inbound_turns set status='unknown' where id=older.id;
  assert public.access_hermes_owned_baseline(p.id,p.lease_token,'candidate',payload) is null,'Older unknown blocks genesis and continuity';
  update public.hermes_inbound_turns set status='queued' where id=older.id;
  assert public.access_hermes_owned_baseline(p.id,p.lease_token,'candidate',payload) is null,'Older queued blocks continuity';
  update public.hermes_inbound_turns set status='completed',response='{"changed":true}' where id=older.id;
  assert public.access_hermes_owned_baseline(p.id,p.lease_token,'capture',payload||jsonb_build_object('candidate',candidate,'candidateFingerprint',repeat('a',64),'conversation',receipt->'conversation')) is null,'Changed source refuses stale capture';
end;
$$;
