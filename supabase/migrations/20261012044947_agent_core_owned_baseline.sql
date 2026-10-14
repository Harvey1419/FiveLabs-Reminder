-- Prepared only. Capture an independently validated, closed checkpoint before claiming an active run.
create table public.hermes_owned_baselines (
  id uuid primary key, user_id uuid not null references public.users(id) on delete cascade,
  inbound_run_id uuid not null unique references public.hermes_inbound_turns(id) on delete cascade,
  receipt jsonb not null, created_at timestamptz not null default clock_timestamp()
);
alter table public.hermes_owned_baselines enable row level security;
revoke all on public.hermes_owned_baselines from public,anon,authenticated,service_role;
grant select,insert on public.hermes_owned_baselines to service_role;
create policy owned_baseline_backend on public.hermes_owned_baselines for all to service_role using(true) with check(true);

create function public.access_hermes_owned_baseline(p_owner_id uuid,p_owner_token uuid,p_operation text,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare owner_row public.hermes_inbound_turns; prior_row public.hermes_inbound_turns; candidate jsonb; value jsonb;
  source jsonb; u uuid; active_id uuid; baseline_id uuid;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or coalesce(p_operation not in ('candidate','capture','read'),true) then return null; end if;
  select * into owner_row from public.hermes_inbound_turns where id=p_owner_id and lease_token=p_owner_token and status='running'
    and lease_expires_at>clock_timestamp() for update;
  if not found then return null; end if;
  if p_operation='read' then
    u:=(p_payload->'expected'->'run'->>'user_id')::uuid;
    source:=public.read_hermes_active_run_recovery(p_owner_id,p_owner_token,u,owner_row.message_id,owner_row.thread_id);
    if source is null or source is distinct from p_payload->'expected' then return null; end if;
    select receipt into value from public.hermes_owned_baselines where user_id=u and inbound_run_id=(source->'prior'->>'id')::uuid;
    if not found or owner_row.lease_expires_at<=clock_timestamp() then return null; end if;
    return value;
  end if;
  u:=(p_payload->>'userId')::uuid; active_id:=(p_payload->>'activeRunId')::uuid;
  if coalesce(owner_row.response ?| array['agentCore','agentCoreProductivity','agentCoreResolution','agentCoreActiveRun','agentCoreActiveResolution','agentCoreActiveCompletion','agentCoreDeliveryManifest','agentCoreBaseline'],false)
    or not exists(select 1 from public.agent_runs where id=active_id and user_id=u and thread_id=owner_row.thread_id
      and status in ('waiting_for_approval','waiting_for_input') and expires_at>clock_timestamp() and not coalesce(context ? '_agentCoreClaim',false)) then return null; end if;
  -- Every older unresolved/unsupported queue state blocks continuity; never skip it to invent genesis.
  if exists(select 1 from public.hermes_inbound_turns where thread_id=owner_row.thread_id and sequence_id<owner_row.sequence_id and status<>'completed') then return null; end if;
  select * into prior_row from public.hermes_inbound_turns where thread_id=owner_row.thread_id and sequence_id<owner_row.sequence_id
    order by sequence_id desc limit 1 for update;
  candidate:=jsonb_build_object('version',1,'userId',u::text,'inboundRunId',owner_row.id::text,'activeRunId',active_id::text,
    'requestId',owner_row.message_id,'threadId',owner_row.thread_id,'sequenceId',owner_row.sequence_id,'prior',
    case when prior_row.id is null then 'null'::jsonb else jsonb_build_object('id',prior_row.id::text,'message_id',prior_row.message_id,
      'thread_id',prior_row.thread_id,'sequence_id',prior_row.sequence_id,'status',prior_row.status,'response',prior_row.response) end);
  if p_operation='candidate' then
    if owner_row.lease_expires_at<=clock_timestamp() then return null; end if;
    return candidate;
  end if;
  if candidate is distinct from p_payload->'candidate' or p_payload->'conversation'->>'userId' is distinct from u::text
    or jsonb_typeof(p_payload->'conversation') is distinct from 'object'
    or coalesce(p_payload->>'candidateFingerprint','') !~ '^[a-f0-9]{64}$' then return null; end if;
  if p_payload ? 'input' and (coalesce(p_payload->>'inputFingerprint','') !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_payload->'input') is distinct from 'object'
    or length(coalesce(p_payload->'input'->>'userText','')) not between 1 and 8000
    or coalesce(p_payload->'input'->>'language','') not in ('es','en')
    or length(coalesce(p_payload->'input'->>'timezone','')) not between 1 and 128) then return null; end if;
  baseline_id:=gen_random_uuid();
  value:=jsonb_build_object('version',1,'id',baseline_id::text,'candidate',candidate,'conversation',p_payload->'conversation');
  if p_payload ? 'input' then value:=value||jsonb_build_object('input',p_payload->'input'); end if;
  if owner_row.lease_expires_at<=clock_timestamp() then return null; end if;
  insert into public.hermes_owned_baselines(id,user_id,inbound_run_id,receipt) values(baseline_id,u,owner_row.id,value);
  update public.hermes_inbound_turns set response=coalesce(response,'{}'::jsonb)||jsonb_build_object('agentCoreBaseline',
    jsonb_build_object('version',1,'baselineId',baseline_id::text,'candidateFingerprint',p_payload->>'candidateFingerprint')||case when p_payload ? 'input' then jsonb_build_object('inputRecorded',true,'inputFingerprint',p_payload->>'inputFingerprint') else '{}'::jsonb end) where id=owner_row.id;
  if owner_row.lease_expires_at<=clock_timestamp() then raise exception 'OWNED_BASELINE_LEASE_EXPIRED' using errcode='40001'; end if;
  return value;
exception when invalid_text_representation then return null;
end;
$$;
revoke execute on function public.access_hermes_owned_baseline(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.access_hermes_owned_baseline(uuid,uuid,text,jsonb) to service_role;
