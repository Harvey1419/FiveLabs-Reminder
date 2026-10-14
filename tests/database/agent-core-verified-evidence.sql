-- Caller loads actual queue/run/RPC DDL in a rolled-back local transaction.
do $$
#variable_conflict use_variable
declare u uuid := gen_random_uuid(); t text := 'active-evidence-'||gen_random_uuid()::text;
  prior public.hermes_inbound_turns; owner_row public.hermes_inbound_turns; run_id uuid; late_rejected boolean := false;
  expected jsonb; claim jsonb; source jsonb; resolution jsonb; changed jsonb; original jsonb; receipt jsonb; request jsonb;
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

  receipt := jsonb_build_object('version',1,'kind','effect','authority','domain_audit','userId',u::text,'activeRunId',run_id::text,
    'inboundRunId',prior.id::text,'threadId',t,'sourceFingerprint',repeat('a',64),'evidenceKey','a:'||repeat('b',64),
    'verifiedAtIso','2026-10-12T02:00:00Z','proof',jsonb_build_object('userId',u::text,'activeRunId',run_id::text,'callId','a',
      'actionFingerprint',repeat('b',64),'evidenceId','independent-audit','outcome','no_effect','coversCompanions',true,'item',null));
  request := jsonb_build_object('kind','effect','evidenceKey',receipt->>'evidenceKey','sourceFingerprint',repeat('a',64));
  assert public.access_hermes_active_evidence(owner_row.id,owner_row.lease_token,source,'read',request) is null,'Missing audit is unavailable';
  assert (select count(*)=0 from public.hermes_verified_active_evidence),'Read does not fabricate receipts';
  assert public.access_hermes_active_evidence(owner_row.id,gen_random_uuid(),source,'register',receipt) is null,'Wrong registrar lease denied';
  assert public.access_hermes_active_evidence(owner_row.id,owner_row.lease_token,source,'register',receipt||'{"authority":"model"}') is null,'Model authority denied';
  assert public.access_hermes_active_evidence(owner_row.id,owner_row.lease_token,source,'register',receipt||jsonb_build_object('userId',gen_random_uuid()::text)) is null,'Foreign receipt denied';
  assert public.access_hermes_active_evidence(owner_row.id,owner_row.lease_token,source,'register',receipt||'{"evidenceKey":"foreign"}') is null,'Forged evidence key denied';
  assert public.access_hermes_active_evidence(owner_row.id,owner_row.lease_token,source,'register',receipt)=receipt,'Verified receipt published';
  assert public.access_hermes_active_evidence(owner_row.id,owner_row.lease_token,source,'register',receipt)=receipt,'Exact publication idempotent';
  assert (select count(*)=1 from public.hermes_verified_active_evidence),'Only one immutable row';
  assert public.access_hermes_active_evidence(owner_row.id,owner_row.lease_token,source,'register',receipt||'{"verifiedAtIso":"2026-10-12T02:01:00Z"}') is null,'Different receipt cannot overwrite';
  assert public.access_hermes_active_evidence(owner_row.id,owner_row.lease_token,source,'read',request)=receipt,'Scoped persisted receipt read';
  assert public.access_hermes_active_evidence(owner_row.id,owner_row.lease_token,source,'read',request||jsonb_build_object('sourceFingerprint',repeat('c',64))) is null,'Different source unavailable';
  update public.hermes_inbound_turns set response=response||'{"changed":true}' where id=prior.id;
  assert public.access_hermes_active_evidence(owner_row.id,owner_row.lease_token,source,'read',request) is null,'Stale checkpoint rejected';
  update public.hermes_inbound_turns set response=original where id=prior.id;
  update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()-interval '1 second' where id=owner_row.id;
  assert public.access_hermes_active_evidence(owner_row.id,owner_row.lease_token,source,'read',request) is null,'Expired reader denied';
  -- Force expiry after the insert boundary; raising rolls back that publication statement.
  update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()+interval '1 second' where id=owner_row.id;
  execute $trigger$create function pg_temp.delay_verified_receipt() returns trigger language plpgsql as
    'begin perform pg_sleep(1.2); return NEW; end;'$trigger$;
  create trigger delay_verified_receipt before insert on public.hermes_verified_active_evidence
    for each row execute function pg_temp.delay_verified_receipt();
  changed := receipt||jsonb_build_object('kind','delivery','authority','delivery_audit','evidenceKey',prior.id::text||':'||repeat('a',64),
    'proof',jsonb_build_object('userId',u::text,'inboundRunId',prior.id::text,'sourceFingerprint',repeat('a',64),
      'evidenceId','independent-sender-audit','outcome','not_sent','messageIds','[]'::jsonb));
  begin
    perform public.access_hermes_active_evidence(owner_row.id,owner_row.lease_token,source,'register',changed);
  exception when serialization_failure then late_rejected := true;
  end;
  assert late_rejected,'Late publication raises instead of committing under expired ownership';
  assert (select count(*)=1 from public.hermes_verified_active_evidence),'Late publication preserves original journal only';
  drop trigger delay_verified_receipt on public.hermes_verified_active_evidence;
  assert not has_table_privilege('anon','public.hermes_verified_active_evidence','select'),'Anonymous receipts hidden';
  assert not has_table_privilege('authenticated','public.hermes_verified_active_evidence','insert'),'User cannot publish receipts';
  assert has_table_privilege('service_role','public.hermes_verified_active_evidence','select')
    and has_table_privilege('service_role','public.hermes_verified_active_evidence','insert'),'Backend reads/inserts allowed';
  assert not has_table_privilege('service_role','public.hermes_verified_active_evidence','update'),'Backend cannot rewrite receipts';
  assert not has_table_privilege('service_role','public.hermes_verified_active_evidence','delete'),'Backend cannot delete receipts';
  assert (select relrowsecurity from pg_class where oid='public.hermes_verified_active_evidence'::regclass),'Audit RLS enabled';
  assert not has_function_privilege('anon','public.access_hermes_active_evidence(uuid,uuid,jsonb,text,jsonb)','execute'),'Anonymous RPC denied';
  assert not has_function_privilege('authenticated','public.access_hermes_active_evidence(uuid,uuid,jsonb,text,jsonb)','execute'),'User RPC denied';
  assert (select not prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='public.access_hermes_active_evidence(uuid,uuid,jsonb,text,jsonb)'::regprocedure),'Invoker RPC with empty search path';
end;
$$;
