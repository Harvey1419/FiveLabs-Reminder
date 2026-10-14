-- Prepared only. Complete sealed plans and write-before-send fences; no provider dispatch inside SQL.
create table public.hermes_delivery_manifests (
  id uuid primary key, user_id uuid not null references public.users(id) on delete cascade,
  inbound_run_id uuid not null unique references public.hermes_inbound_turns(id) on delete cascade,
  manifest jsonb not null, created_at timestamptz not null default clock_timestamp()
);
alter table public.hermes_delivery_manifests enable row level security;
revoke all on public.hermes_delivery_manifests from public,anon,authenticated,service_role;
grant select,insert,update on public.hermes_delivery_manifests to service_role;
create policy delivery_manifest_backend on public.hermes_delivery_manifests for all to service_role using(true) with check(true);

create function public.access_hermes_delivery_manifest(p_owner_id uuid,p_owner_token uuid,p_operation text,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare owner_row public.hermes_inbound_turns; current_snapshot jsonb; value jsonb; draft jsonb; checkpoint jsonb;
  manifest_id uuid; u uuid; idx integer; matched integer; next_state text; provider_id text;
begin
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or coalesce(p_operation not in ('seal','attempt','accept','unknown','read'),true) then return null; end if;
  select * into owner_row from public.hermes_inbound_turns where id=p_owner_id and lease_token=p_owner_token and status='running'
    and lease_expires_at>clock_timestamp() for update;
  if not found then return null; end if;
  if p_operation='read' then
    if p_payload->'expected'->'anchor'->>'id' is distinct from owner_row.id::text then return null; end if;
    u:=(p_payload->'expected'->'run'->>'user_id')::uuid;
    current_snapshot:=public.read_hermes_active_run_recovery(p_owner_id,p_owner_token,u,owner_row.message_id,owner_row.thread_id);
    if current_snapshot is null or current_snapshot is distinct from p_payload->'expected' then return null; end if;
    select manifest into value from public.hermes_delivery_manifests where user_id=u
      and inbound_run_id=(current_snapshot->'prior'->>'id')::uuid;
    if not found or owner_row.lease_expires_at<=clock_timestamp() then return null; end if;
    return value;
  end if;
  if p_operation='seal' then
    draft:=p_payload->'draft'; checkpoint:=owner_row.response->'agentCoreActiveRun';
    if owner_row.response is distinct from p_payload->'expectedResponse' or coalesce(owner_row.response ? 'agentCoreDeliveryManifest',false)
      or checkpoint->>'stage' is distinct from 'final' or draft->>'version' is distinct from '1'
      or draft->>'userId' is distinct from checkpoint->>'userId' or draft->>'inboundRunId' is distinct from owner_row.id::text
      or draft->>'activeRunId' is distinct from checkpoint->>'runId' or draft->>'requestId' is distinct from owner_row.message_id
      or draft->>'threadId' is distinct from owner_row.thread_id or draft->'sourceResponse' is distinct from owner_row.response
      or coalesce(p_payload->>'sourceFingerprint','') !~ '^[a-f0-9]{64}$'
      or jsonb_typeof(draft->'entries') is distinct from 'array' then return null; end if;
    if jsonb_array_length(draft->'entries')>12 or exists(select 1 from jsonb_array_elements(draft->'entries') e
      where e->>'state' is distinct from 'ready' or e->'providerMessageId' is distinct from 'null'::jsonb
        or coalesce(e->'message'->>'id','')='') then return null; end if;
    if (select count(distinct e->'message'->>'id') from jsonb_array_elements(draft->'entries') e)<>jsonb_array_length(draft->'entries') then return null; end if;
    u:=(draft->>'userId')::uuid;
    if not exists(select 1 from public.agent_runs where id=(draft->>'activeRunId')::uuid and user_id=u and thread_id=owner_row.thread_id
      and status in ('completed','failed','cancelled','waiting_for_input')) then return null; end if;
    manifest_id:=gen_random_uuid(); value:=draft||jsonb_build_object('id',manifest_id::text);
    if owner_row.lease_expires_at<=clock_timestamp() then return null; end if;
    insert into public.hermes_delivery_manifests(id,user_id,inbound_run_id,manifest) values(manifest_id,u,owner_row.id,value);
    update public.hermes_inbound_turns set response=response||jsonb_build_object('agentCoreDeliveryManifest',
      jsonb_build_object('version',1,'manifestId',manifest_id::text,'sourceFingerprint',p_payload->>'sourceFingerprint')) where id=owner_row.id;
  else
    select manifest into value from public.hermes_delivery_manifests where inbound_run_id=owner_row.id
      and id=(p_payload->>'manifestId')::uuid for update;
    if not found or owner_row.response->'agentCoreDeliveryManifest'->>'manifestId' is distinct from value->>'id' then return null; end if;
    select count(*) into matched from jsonb_array_elements(value->'entries') e where e->'message'=p_payload->'message';
    if matched<>1 then return null; end if;
    select ordinality::integer-1 into idx from jsonb_array_elements(value->'entries') with ordinality e(entry,ordinality)
      where entry->'message'=p_payload->'message';
    if p_operation='attempt' then
      if value->'entries'->idx->>'state' is distinct from 'ready' then return null; end if;
      if exists(select 1 from jsonb_array_elements(value->'entries') with ordinality e(entry,n)
        where n<=idx and entry->>'state'<>'accepted') then return null; end if;
      next_state:='attempted';
    else
      if value->'entries'->idx->>'state' is distinct from 'attempted' then return null; end if;
      next_state:=case when p_operation='accept' then 'accepted' else 'unknown' end;
      if p_operation='accept' then
        provider_id:=p_payload->>'providerMessageId';
        if coalesce(btrim(provider_id),'')='' or length(provider_id)>256
          or exists(select 1 from jsonb_array_elements(value->'entries') e where e->>'providerMessageId'=provider_id) then return null; end if;
      end if;
    end if;
    value:=jsonb_set(value,array['entries',idx::text,'state'],to_jsonb(next_state));
    if provider_id is not null then value:=jsonb_set(value,array['entries',idx::text,'providerMessageId'],to_jsonb(provider_id)); end if;
    if owner_row.lease_expires_at<=clock_timestamp() then return null; end if;
    update public.hermes_delivery_manifests set manifest=value where id=(value->>'id')::uuid;
  end if;
  if owner_row.lease_expires_at<=clock_timestamp() then raise exception 'DELIVERY_MANIFEST_LEASE_EXPIRED' using errcode='40001'; end if;
  return value;
exception when invalid_text_representation then return null;
end;
$$;
revoke execute on function public.access_hermes_delivery_manifest(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.access_hermes_delivery_manifest(uuid,uuid,text,jsonb) to service_role;
