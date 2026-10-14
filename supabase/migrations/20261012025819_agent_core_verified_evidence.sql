-- Prepared only: immutable verified receipts, never inference from missing rows or legacy prose.
create table public.hermes_verified_active_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  inbound_run_id uuid not null references public.hermes_inbound_turns(id) on delete cascade,
  thread_id text not null, source_fingerprint text not null check(source_fingerprint ~ '^[a-f0-9]{64}$'),
  kind text not null check(kind in ('effect','delivery','baseline')), evidence_key text not null,
  receipt jsonb not null check(jsonb_typeof(receipt)='object'), created_at timestamptz not null default clock_timestamp(),
  unique(user_id,run_id,inbound_run_id,source_fingerprint,kind,evidence_key)
);
alter table public.hermes_verified_active_evidence enable row level security;
revoke all on public.hermes_verified_active_evidence from public,anon,authenticated,service_role;
grant select,insert on public.hermes_verified_active_evidence to service_role;
create policy verified_active_backend_read on public.hermes_verified_active_evidence for select to service_role using(true);
create policy verified_active_backend_insert on public.hermes_verified_active_evidence for insert to service_role with check(true);

create function public.access_hermes_active_evidence(
  p_owner_id uuid,p_owner_token uuid,p_expected jsonb,p_operation text,p_payload jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare current_snapshot jsonb; u uuid; r uuid; inbound uuid; fingerprint text; k text; key_text text;
  existing jsonb; expiry timestamptz; expected_key text;
begin
  if p_expected is null or jsonb_typeof(p_expected)<>'object' or p_payload is null or jsonb_typeof(p_payload)<>'object'
    or p_expected->'anchor'->>'id' is distinct from p_owner_id::text
    or coalesce(p_operation not in ('read','register'),true) then return null; end if;
  u := (p_expected->'run'->>'user_id')::uuid; r := (p_expected->'run'->>'id')::uuid; inbound := (p_expected->'prior'->>'id')::uuid;
  current_snapshot := public.read_hermes_active_run_recovery(p_owner_id,p_owner_token,u,
    p_expected->'anchor'->>'message_id',p_expected->'anchor'->>'thread_id');
  if current_snapshot is null or current_snapshot is distinct from p_expected then return null; end if;
  fingerprint := p_payload->>'sourceFingerprint'; k := p_payload->>'kind'; key_text := p_payload->>'evidenceKey';
  if coalesce(k not in ('effect','delivery','baseline'),true) or coalesce(key_text,'')='' or length(key_text)>400 then return null; end if;
  if p_operation='register' then
    if p_payload->>'version' is distinct from '1' or p_payload->>'userId' is distinct from u::text
      or p_payload->>'activeRunId' is distinct from r::text or p_payload->>'inboundRunId' is distinct from inbound::text
      or p_payload->>'threadId' is distinct from p_expected->'run'->>'thread_id'
      or p_payload->'proof'->>'userId' is distinct from u::text
      or coalesce(fingerprint,'') !~ '^[a-f0-9]{64}$' or coalesce(p_payload->>'verifiedAtIso','')='' then return null; end if;
    if k='effect' then
      if p_payload->>'authority' is distinct from 'domain_audit' or p_payload->'proof'->>'activeRunId' is distinct from r::text
        or p_payload->'proof'->'coversCompanions' is distinct from 'true'::jsonb
        or coalesce(p_payload->'proof'->>'actionFingerprint','') !~ '^[a-f0-9]{64}$'
        or not exists(select 1 from jsonb_array_elements(p_expected->'actions') a where a->>'callId'=p_payload->'proof'->>'callId'
          and (a->>'status' in ('executed','failed') or a->'executionFact' is distinct from 'null'::jsonb)) then return null; end if;
      expected_key := (p_payload->'proof'->>'callId')||':'||(p_payload->'proof'->>'actionFingerprint');
    else
      if p_payload->'proof'->>'sourceFingerprint' is distinct from fingerprint then return null; end if;
      expected_key := inbound::text||':'||fingerprint;
      if k='delivery' and (p_payload->>'authority' is distinct from 'delivery_audit'
        or p_payload->'proof'->>'inboundRunId' is distinct from inbound::text) then return null; end if;
      if k='baseline' and (p_payload->>'authority' is distinct from 'owned_checkpoint'
        or p_payload->'proof'->>'threadId' is distinct from p_expected->'run'->>'thread_id'
        or p_payload->'proof'->'conversation'->>'userId' is distinct from u::text) then return null; end if;
    end if;
    if key_text is distinct from expected_key then return null; end if;
    select lease_expires_at into expiry from public.hermes_inbound_turns where id=p_owner_id;
    if expiry<=clock_timestamp() then return null; end if;
    insert into public.hermes_verified_active_evidence(user_id,run_id,inbound_run_id,thread_id,source_fingerprint,kind,evidence_key,receipt)
      values(u,r,inbound,p_expected->'run'->>'thread_id',fingerprint,k,key_text,p_payload) on conflict do nothing;
  else
    fingerprint := p_payload->>'sourceFingerprint';
    if coalesce(fingerprint,'') !~ '^[a-f0-9]{64}$' then return null; end if;
  end if;
  select receipt into existing from public.hermes_verified_active_evidence where user_id=u and run_id=r
    and inbound_run_id=inbound and thread_id=p_expected->'run'->>'thread_id' and source_fingerprint=fingerprint and kind=k and evidence_key=key_text;
  if not found or p_operation='register' and existing is distinct from p_payload then return null; end if;
  select lease_expires_at into expiry from public.hermes_inbound_turns where id=p_owner_id;
  if expiry<=clock_timestamp() then
    if p_operation='register' then raise exception 'ACTIVE_EVIDENCE_LEASE_EXPIRED' using errcode='40001'; end if;
    return null;
  end if;
  return existing;
exception when invalid_text_representation then return null;
end;
$$;
revoke execute on function public.access_hermes_active_evidence(uuid,uuid,jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function public.access_hermes_active_evidence(uuid,uuid,jsonb,text,jsonb) to service_role;
