-- Test-only delayed write exercises lease expiration after the update boundary.
create function public.agent_core_test_completion_delay() returns trigger language plpgsql as $$
begin
  if new.response ? 'agentCoreActiveCompletion' and not coalesce(old.response ? 'agentCoreActiveCompletion',false) then perform pg_sleep(0.08); end if;
  return new;
end;
$$;
create trigger agent_core_test_completion_delay before update on public.hermes_inbound_turns for each row execute function public.agent_core_test_completion_delay();
-- Caller rolls back the entire local fixture.
do $$
#variable_conflict use_variable
declare u uuid:=gen_random_uuid(); t text:='completion-'||gen_random_uuid()::text; r uuid; p public.hermes_inbound_turns;
  candidate jsonb; baseline jsonb; payload jsonb; claim jsonb; snapshot jsonb; source jsonb; manifest jsonb; completion jsonb; original jsonb;
  expired_write boolean:=false;
  text_reply text:='Cancelado. No se aplicaron los cambios pendientes.';
begin
  insert into public.users(id) values(u);
  insert into public.agent_runs(user_id,thread_id,status,kind,context,expires_at) values(u,t,'waiting_for_approval','generic_operation','{}',clock_timestamp()+interval '1 hour') returning id into r;
  insert into public.prepared_actions(run_id,call_id,domain,action,payload) values(r,'a','task','delete','{}');
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at) values(t,t,'{"retained":true}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into p;
  payload:=jsonb_build_object('userId',u::text,'activeRunId',r::text);
  candidate:=public.access_hermes_owned_baseline(p.id,p.lease_token,'candidate',payload);
  baseline:=public.access_hermes_owned_baseline(p.id,p.lease_token,'capture',payload||jsonb_build_object('candidate',candidate,'candidateFingerprint',repeat('a',64),
    'inputFingerprint',repeat('d',64),'input','{"userText":"Cancela","language":"es","timezone":"America/Bogota"}'::jsonb,'conversation',jsonb_build_object('userId',u::text,'history','[]'::jsonb,'tasks','[]'::jsonb,'reminders','[]'::jsonb,'events','[]'::jsonb,'handledRequestIds','[]'::jsonb)));
  assert baseline->'input'->>'userText'='Cancela','User input captured before claim';
  assert (select response->'agentCoreBaseline'->'inputRecorded'='true'::jsonb from public.hermes_inbound_turns where id=p.id),'New history namespace fenced';
  select public.agent_core_active_snapshot(r,to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) into snapshot from public.agent_runs where id=r;
  claim:=public.claim_hermes_active_run(p.id,p.lease_token,snapshot,'cancelled','{"relation":"cancel"}');
  perform public.mutate_hermes_active_run(p.id,p.lease_token,r,(claim->>'claimId')::uuid,'action',jsonb_build_object('callId','a','expected',snapshot->'actions'->0,'updates','{"status":"skipped"}'::jsonb));
  perform public.mutate_hermes_active_run(p.id,p.lease_token,r,(claim->>'claimId')::uuid,'finish','{"success":false,"status":"cancelled"}');
  select response into original from public.hermes_inbound_turns where id=p.id;
  payload:=jsonb_build_object('expectedResponse',original,'sourceFingerprint',repeat('b',64),'draft',jsonb_build_object('version',1,'id',gen_random_uuid()::text,'userId',u::text,'inboundRunId',p.id::text,'activeRunId',r::text,
    'requestId',t,'threadId',t,'sourceResponse',original,'entries',jsonb_build_array(jsonb_build_object('message',jsonb_build_object('id',t||':reply:0','kind','text','text',text_reply),'state','ready','providerMessageId',null))));
  manifest:=public.access_hermes_delivery_manifest(p.id,p.lease_token,'seal',payload);
  assert public.read_hermes_active_turn_completion(p.id,p.lease_token) is null,'Unsent plan cannot finalize';
  payload:=jsonb_build_object('manifestId',manifest->>'id','message',manifest->'entries'->0->'message');
  perform public.access_hermes_delivery_manifest(p.id,p.lease_token,'attempt',payload);
  assert public.read_hermes_active_turn_completion(p.id,p.lease_token) is null,'Attempted message cannot finalize';
  manifest:=public.access_hermes_delivery_manifest(p.id,p.lease_token,'accept',payload||'{"providerMessageId":"provider-final"}');
  source:=public.read_hermes_active_turn_completion(p.id,p.lease_token);
  assert source->'baseline'=baseline and source->'manifest'=manifest,'Finalization reader supplies actual persisted inputs';
  completion:=jsonb_build_object('version',1,'kind','active_turn_completion','sourceFingerprint',repeat('c',64),'sourceResponse',source->'sourceResponse','manifest',manifest,'receipts','[]'::jsonb,
    'baseline',jsonb_build_object('id',baseline->>'id','candidateFingerprint',repeat('a',64),'input',baseline->'input','conversation',baseline->'conversation')||(candidate-'version'-'prior'),
    'conversation',(baseline->'conversation')||jsonb_build_object('handledRequestIds',jsonb_build_array(t),'history',jsonb_build_array(jsonb_build_object('role','user','content','Cancela'),jsonb_build_object('role','assistant','content',text_reply,'toolCalls','[]'::jsonb))));
  assert not public.finish_hermes_active_turn(p.id,gen_random_uuid(),source->'sourceResponse',completion),'Wrong lease denied';
  assert not public.finish_hermes_active_turn(p.id,p.lease_token,'{}',completion),'Whole response CAS required';
  assert not public.finish_hermes_active_turn(p.id,p.lease_token,source->'sourceResponse',jsonb_set(completion,'{baseline,input,userText}','"Changed"')),'Stored user input cannot be forged';
  assert not public.finish_hermes_active_turn(p.id,p.lease_token,source->'sourceResponse',jsonb_set(completion,'{conversation,history,0,content}','"Changed"')),'Conversation must retain exact user input';
  assert not public.finish_hermes_active_turn(p.id,p.lease_token,source->'sourceResponse',jsonb_set(completion,'{conversation,history,1,content}','"Changed"')),'Assistant history must equal accepted reply';
  assert not public.finish_hermes_active_turn(p.id,p.lease_token,source->'sourceResponse',jsonb_set(completion,'{manifest,entries,0,providerMessageId}','"Foreign"')),'Whole persisted delivery receipt required';
  assert (select status='running' and not response ? 'agentCoreActiveCompletion' from public.hermes_inbound_turns where id=p.id),'Rejected closures leave ownership and history unchanged';
  update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()+interval '40 milliseconds' where id=p.id;
  begin
    perform public.finish_hermes_active_turn(p.id,p.lease_token,source->'sourceResponse',completion);
  exception when serialization_failure then expired_write:=true;
  end;
  assert expired_write,'Late expired completion raises to roll back the write';
  assert (select status='running' and not response ? 'agentCoreActiveCompletion' and lease_token is not null and request<>'{}'::jsonb from public.hermes_inbound_turns where id=p.id),'Expired write rolls back history status request cleanup and lease retirement';
  update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()+interval '120 seconds' where id=p.id;
  assert public.finish_hermes_active_turn(p.id,p.lease_token,source->'sourceResponse',completion),'Confirmed cancellation closes atomically';
  assert (select status='completed' and response->'agentCoreActiveCompletion'=completion and request='{}'::jsonb and lease_token is null and lease_expires_at is null from public.hermes_inbound_turns where id=p.id),'History completion request cleanup and lease retirement atomic';
  assert not public.finish_hermes_active_turn(p.id,p.lease_token,source->'sourceResponse',completion),'Retired completion cannot be repeated';
  assert public.read_hermes_active_turn_completion(p.id,p.lease_token) is null,'Retired owner cannot read execution inputs';
  assert not has_function_privilege('anon','public.finish_hermes_active_turn(uuid,uuid,jsonb,jsonb)','execute'),'Finalizer private';
  assert not has_function_privilege('authenticated','public.read_hermes_active_turn_completion(uuid,uuid)','execute'),'Reader private';
end;
$$;
