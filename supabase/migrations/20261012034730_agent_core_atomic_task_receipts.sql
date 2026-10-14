-- Prepared only. Task mutation, companion handling and immutable receipt share one transaction.
create table public.hermes_atomic_task_receipts (
  id uuid primary key, user_id uuid not null references public.users(id) on delete cascade,
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  call_id text not null, receipt jsonb not null, created_at timestamptz not null default clock_timestamp(),
  unique(run_id,call_id)
);
alter table public.hermes_atomic_task_receipts enable row level security;
revoke all on public.hermes_atomic_task_receipts from public,anon,authenticated,service_role;
grant select,insert on public.hermes_atomic_task_receipts to service_role;
create policy atomic_task_backend_read on public.hermes_atomic_task_receipts for select to service_role using(true);
create policy atomic_task_backend_insert on public.hermes_atomic_task_receipts for insert to service_role with check(true);
create index if not exists reminders_atomic_task_lookup on public.reminders(task_id,user_id) where task_id is not null;

create function public.execute_hermes_atomic_task(p_owner_id uuid,p_owner_token uuid,p_user_id uuid,p_call jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare owner_row public.hermes_inbound_turns; run_row public.agent_runs; action_row public.prepared_actions;
  task_row public.tasks; operation text; target uuid; ids uuid[]; entity_name text; record jsonb; item jsonb;
  legacy_result jsonb; receipt jsonb; receipt_id uuid := gen_random_uuid(); claim_id uuid; matched integer;
begin
  if p_call is null or p_call->>'toolName' is distinct from 'manage_task'
    or jsonb_typeof(p_call->'params') is distinct from 'object' or p_call->'params'->>'target' is null
    or coalesce(p_call->'params'->>'action' not in ('complete','delete'),true)
    or (select count(*) from jsonb_object_keys(p_call->'params'))<>2
    or (select count(*) from jsonb_object_keys(p_call))<>2 then return null; end if;
  operation := p_call->'params'->>'action'; target := (p_call->'params'->>'target')::uuid;
  select * into owner_row from public.hermes_inbound_turns where id=p_owner_id and lease_token=p_owner_token
    and status='running' and lease_expires_at>clock_timestamp() for update;
  if not found then return null; end if;
  select * into run_row from public.agent_runs where id=(owner_row.response->'agentCoreActiveRun'->>'runId')::uuid
    and user_id=p_user_id and thread_id=owner_row.thread_id and status='running' for update;
  if not found or run_row.context->'_agentCoreClaim'->>'ownerId' is distinct from p_owner_id::text
    or run_row.context->'_agentCoreClaim'->>'claimId' is distinct from owner_row.response->'agentCoreActiveRun'->>'claimId'
    or run_row.expires_at<=clock_timestamp() then return null; end if;
  claim_id := (run_row.context->'_agentCoreClaim'->>'claimId')::uuid;
  perform 1 from public.prepared_actions where run_id=run_row.id order by call_id collate "C" limit 13 for update;
  select count(*) into matched from public.prepared_actions where run_id=run_row.id and status='failed'
    and execution_fact->>'outcome'='unknown' and execution_fact->'_domainCall'=p_call;
  if matched<>1 then return null; end if;
  select * into action_row from public.prepared_actions where run_id=run_row.id and status='failed'
    and execution_fact->>'outcome'='unknown' and execution_fact->'_domainCall'=p_call;
  if action_row.domain<>'task' or action_row.action<>operation or action_row.target_id is distinct from target then return null; end if;
  select r.receipt into receipt from public.hermes_atomic_task_receipts r where r.run_id=run_row.id and r.call_id=action_row.call_id;
  if found then
    if receipt->'domainCall' is distinct from p_call or receipt->>'userId' is distinct from p_user_id::text then return null; end if;
    if owner_row.lease_expires_at<=clock_timestamp() then return null; end if;
    return receipt;
  end if;
  select * into task_row from public.tasks where id=target and user_id=p_user_id for update;
  if not found or operation='complete' and task_row.status<>'pending' then return null; end if;
  if task_row.entity_id is not null then
    select name into entity_name from public.entities where id=task_row.entity_id and user_id=p_user_id;
    if not found then return null; end if;
  end if;
  if length(task_row.title)>2000 or length(task_row.description)>10000 or length(entity_name)>200 then return null; end if;
  perform 1 from public.reminders where task_id=target order by id limit 101 for update;
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into ids from
    (select id from public.reminders where task_id=target order by id limit 101) bounded;
  if cardinality(ids)>100 or exists(select 1 from public.reminders where task_id=target and
    (user_id is distinct from p_user_id or status='processing' or lock_until>clock_timestamp())) then return null; end if;
  if owner_row.lease_expires_at<=clock_timestamp() or run_row.expires_at<=clock_timestamp() then return null; end if;
  if operation='complete' then
    update public.tasks set status='completed',completed_at=clock_timestamp(),updated_at=clock_timestamp()
      where id=target and user_id=p_user_id returning * into task_row;
    update public.reminders set acknowledged_at=clock_timestamp(),status='sent' where task_id=target and user_id=p_user_id
      and acknowledged_at is null and status<>'cancelled';
  else
    update public.reminders set status='cancelled' where task_id=target and user_id=p_user_id and status='pending';
    delete from public.tasks where id=target and user_id=p_user_id;
  end if;
  record := jsonb_build_object('id',target::text,'title',task_row.title,'description',task_row.description,'priority',task_row.priority,
    'status',case when operation='delete' then 'deleted' else 'completed' end,'dueDateIso',task_row.due_date,
    'entityId',task_row.entity_id::text,'entityName',entity_name);
  item := jsonb_build_object('domain','tasks','callId',action_row.call_id,'toolName','task_'||operation,'status','success','code',null,
    'result',jsonb_build_object('operation',operation,'records',jsonb_build_array(record),'complete',true,'coverage','operation',
      'issues','[]'::jsonb,'flow',null,'presentation',jsonb_build_object('canonicalCard',null,'questions','[]'::jsonb,'cta',null)));
  legacy_result := jsonb_build_object('success',true,'complete',true,'outcome','success','action',
    case when operation='complete' then 'completed_task' else 'deleted_task' end,
    'data',to_jsonb(task_row)||jsonb_build_object('entityName',entity_name));
  receipt := jsonb_build_object('version',1,'receiptId',receipt_id::text,'userId',p_user_id::text,'activeRunId',run_row.id::text,
    'inboundRunId',p_owner_id::text,'claimId',claim_id::text,'threadId',run_row.thread_id,'callId',action_row.call_id,'targetId',target::text,
    'domainCall',p_call,'item',item,'legacyResult',legacy_result,'companionReminderIds',to_jsonb(ids));
  insert into public.hermes_atomic_task_receipts(id,user_id,run_id,call_id,receipt) values(receipt_id,p_user_id,run_row.id,action_row.call_id,receipt);
  if owner_row.lease_expires_at<=clock_timestamp() or run_row.expires_at<=clock_timestamp() then
    raise exception 'ATOMIC_TASK_LEASE_EXPIRED' using errcode='40001';
  end if;
  return receipt;
exception when invalid_text_representation then return null;
end;
$$;

create function public.read_hermes_atomic_task_receipt(p_owner_id uuid,p_owner_token uuid,p_expected jsonb,p_call_id text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare current_snapshot jsonb; result jsonb; u uuid;
begin
  if p_expected is null or p_expected->'anchor'->>'id' is distinct from p_owner_id::text then return null; end if;
  u := (p_expected->'run'->>'user_id')::uuid;
  current_snapshot := public.read_hermes_active_run_recovery(p_owner_id,p_owner_token,u,
    p_expected->'anchor'->>'message_id',p_expected->'anchor'->>'thread_id');
  if current_snapshot is null or current_snapshot is distinct from p_expected then return null; end if;
  select receipt into result from public.hermes_atomic_task_receipts where user_id=u
    and run_id=(p_expected->'run'->>'id')::uuid and call_id=p_call_id;
  return result;
exception when invalid_text_representation then return null;
end;
$$;
revoke execute on function public.execute_hermes_atomic_task(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
revoke execute on function public.read_hermes_atomic_task_receipt(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.execute_hermes_atomic_task(uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.read_hermes_atomic_task_receipt(uuid,uuid,jsonb,text) to service_role;
