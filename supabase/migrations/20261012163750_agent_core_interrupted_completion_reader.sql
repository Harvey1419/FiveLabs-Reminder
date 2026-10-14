-- Prepared only. Read consistent recorded-input evidence for the oldest interrupted turn.
-- Never completes a turn, changes a lease, sends a message or authorizes an action.
create function public.read_hermes_interrupted_active_completion(
  p_owner_id uuid, p_owner_token uuid, p_user_id uuid, p_request_id text, p_thread_id text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare source jsonb; baseline jsonb; manifest jsonb; receipts jsonb; prior_id uuid; source_run_id uuid; owner_row public.hermes_inbound_turns;
begin
  select * into owner_row from public.hermes_inbound_turns where id=p_owner_id and lease_token=p_owner_token
    and message_id=p_request_id and thread_id=p_thread_id and status='running' and lease_expires_at>clock_timestamp() for update;
  if not found then return null; end if;
  if not exists(select 1 from public.hermes_inbound_turns where thread_id=p_thread_id
    and sequence_id<owner_row.sequence_id and status='unknown') then
    if owner_row.lease_expires_at<=clock_timestamp() then return null; end if;
    return jsonb_build_object('absent',true);
  end if;
  -- Reuse exact owner/order/source locks, bounds and tenant checks from the owned recovery reader.
  source:=public.read_hermes_active_run_recovery(p_owner_id,p_owner_token,p_user_id,p_request_id,p_thread_id);
  if source is null then return null; end if;
  if source=jsonb_build_object('absent',true) or source->'prior'->>'status'='completed' then
    return jsonb_build_object('absent',true);
  end if;
  if source->'prior'->'response'->'agentCoreBaseline'->>'inputRecorded' is distinct from 'true'
    or source->'prior'->'response'->'agentCoreBaseline'->>'version' is distinct from '1'
    or coalesce(source->'prior'->'response' ? 'agentCoreActiveCompletion',false) then return null; end if;
  prior_id:=(source->'prior'->>'id')::uuid; source_run_id:=(source->'run'->>'id')::uuid;
  select b.receipt into baseline from public.hermes_owned_baselines b where b.inbound_run_id=prior_id and b.user_id=p_user_id;
  select m.manifest into manifest from public.hermes_delivery_manifests m where m.inbound_run_id=prior_id and m.user_id=p_user_id for update;
  select coalesce(jsonb_agg(r.receipt order by r.call_id collate "C"),'[]'::jsonb) into receipts
    from (select call_id,receipt from public.hermes_atomic_task_receipts where run_id=source_run_id and user_id=p_user_id
      order by call_id collate "C" limit 13) r;
  if not exists(select 1 from public.hermes_inbound_turns where id=p_owner_id and lease_token=p_owner_token
    and status='running' and lease_expires_at>clock_timestamp()) then return null; end if;
  return jsonb_build_object('snapshot',source,'baseline',baseline,'manifest',manifest,'receipts',receipts);
exception when invalid_text_representation then return null;
end;
$$;
revoke execute on function public.read_hermes_interrupted_active_completion(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.read_hermes_interrupted_active_completion(uuid,uuid,uuid,text,text) to service_role;
