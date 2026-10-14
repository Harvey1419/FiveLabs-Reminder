-- Complete sealed plan, monotonic fences and acceptance receipts inside caller's rollback transaction.
do $$
#variable_conflict use_variable
declare u uuid:=gen_random_uuid(); t text:='delivery-'||gen_random_uuid()::text; r uuid; owner_row public.hermes_inbound_turns;
  expected jsonb; source jsonb; original jsonb; claim jsonb; draft jsonb; value jsonb; payload jsonb; recovery public.hermes_inbound_turns;
begin
  insert into public.users(id) values(u);
  insert into public.agent_runs(user_id,thread_id,status,kind,context,expires_at) values(u,t,'waiting_for_approval','generic_operation','{}',clock_timestamp()+interval '1 hour') returning id into r;
  insert into public.prepared_actions(run_id,call_id,domain,action,payload) values(r,'a','task','delete','{}');
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at)
    values(t,t,'{}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into owner_row;
  select public.agent_core_active_snapshot(r,to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) into expected from public.agent_runs where id=r;
  claim:=public.claim_hermes_active_run(owner_row.id,owner_row.lease_token,expected,'cancelled','{"relation":"cancel"}');
  perform public.mutate_hermes_active_run(owner_row.id,owner_row.lease_token,r,(claim->>'claimId')::uuid,'action',
    jsonb_build_object('callId','a','expected',expected->'actions'->0,'updates','{"status":"skipped"}'::jsonb));
  perform public.mutate_hermes_active_run(owner_row.id,owner_row.lease_token,r,(claim->>'claimId')::uuid,'finish','{"success":false,"status":"cancelled"}');
  select response into original from public.hermes_inbound_turns where id=owner_row.id;
  draft:=jsonb_build_object('version',1,'id',gen_random_uuid()::text,'userId',u::text,'inboundRunId',owner_row.id::text,'activeRunId',r::text,
    'requestId',t,'threadId',t,'sourceResponse',original,'entries',jsonb_build_array(
      jsonb_build_object('message',jsonb_build_object('id',t||':reply:0','kind','text','text','First'),'state','ready','providerMessageId',null),
      jsonb_build_object('message',jsonb_build_object('id',t||':reply:1','kind','text','text','Second'),'state','ready','providerMessageId',null)));
  payload:=jsonb_build_object('expectedResponse',original,'sourceFingerprint',repeat('a',64),'draft',draft);
  assert public.access_hermes_delivery_manifest(owner_row.id,gen_random_uuid(),'seal',payload) is null,'Wrong lease cannot seal';
  assert public.access_hermes_delivery_manifest(owner_row.id,owner_row.lease_token,'seal',jsonb_set(payload,'{draft,userId}',to_jsonb(gen_random_uuid()::text))) is null,'Foreign owner cannot seal';
  assert public.access_hermes_delivery_manifest(owner_row.id,owner_row.lease_token,'seal',jsonb_set(payload,'{expectedResponse}','{}')) is null,'Whole response CAS required';
  value:=public.access_hermes_delivery_manifest(owner_row.id,owner_row.lease_token,'seal',payload);
  assert jsonb_array_length(value->'entries')=2,'Full plan sealed';
  assert (select response->'agentCoreDeliveryManifest'->>'manifestId'=value->>'id' from public.hermes_inbound_turns where id=owner_row.id),'Manifest marker atomic with plan';
  assert public.access_hermes_delivery_manifest(owner_row.id,owner_row.lease_token,'seal',payload) is null,'Second plan denied';
  payload:=jsonb_build_object('manifestId',value->>'id','message',value->'entries'->1->'message');
  assert public.access_hermes_delivery_manifest(owner_row.id,owner_row.lease_token,'attempt',payload) is null,'Cannot skip earlier message';
  payload:=jsonb_set(payload,'{message}',value->'entries'->0->'message');
  assert public.access_hermes_delivery_manifest(owner_row.id,owner_row.lease_token,'accept',payload||'{"providerMessageId":"p1"}') is null,'Acceptance without attempt denied';
  value:=public.access_hermes_delivery_manifest(owner_row.id,owner_row.lease_token,'attempt',payload);
  assert value->'entries'->0->>'state'='attempted','Write-before-send fence persisted';
  assert public.access_hermes_delivery_manifest(owner_row.id,owner_row.lease_token,'attempt',payload) is null,'Repeated attempt denied';
  assert public.access_hermes_delivery_manifest(owner_row.id,owner_row.lease_token,'accept',payload) is null,'Missing provider identity denied';
  value:=public.access_hermes_delivery_manifest(owner_row.id,owner_row.lease_token,'accept',payload||'{"providerMessageId":"p1"}');
  assert value->'entries'->0->>'state'='accepted','Acceptance persisted';
  assert public.access_hermes_delivery_manifest(owner_row.id,owner_row.lease_token,'unknown',payload) is null,'Accepted receipt cannot be downgraded';
  payload:=jsonb_set(payload,'{message}',value->'entries'->1->'message');
  perform public.access_hermes_delivery_manifest(owner_row.id,owner_row.lease_token,'attempt',payload);
  assert public.access_hermes_delivery_manifest(owner_row.id,owner_row.lease_token,'accept',payload||'{"providerMessageId":"p1"}') is null,'Duplicate provider identity denied';
  value:=public.access_hermes_delivery_manifest(owner_row.id,owner_row.lease_token,'unknown',payload);
  assert value->'entries'->1->>'state'='unknown','Uncertain send retained';
  assert public.access_hermes_delivery_manifest(owner_row.id,owner_row.lease_token,'attempt',payload) is null,'Unknown send never replayed';
  update public.hermes_inbound_turns set status='unknown' where id=owner_row.id;
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at)
    values(t||'-recover',t,'{}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into recovery;
  source:=public.read_hermes_active_run_recovery(recovery.id,recovery.lease_token,u,recovery.message_id,t);
  assert public.access_hermes_delivery_manifest(recovery.id,recovery.lease_token,'read',jsonb_build_object('expected',source))=value,'Owned recovery sees all sends, including uncertainty';
  assert public.access_hermes_delivery_manifest(owner_row.id,owner_row.lease_token,'attempt',payload) is null,'Retired sender cannot resume';
  assert not has_function_privilege('anon','public.access_hermes_delivery_manifest(uuid,uuid,text,jsonb)','execute'),'Anonymous sender RPC denied';
  assert not has_table_privilege('authenticated','public.hermes_delivery_manifests','select'),'Frontend delivery plans hidden';
  assert (select relrowsecurity from pg_class where oid='public.hermes_delivery_manifests'::regclass),'Manifest RLS enabled';
end;
$$;
