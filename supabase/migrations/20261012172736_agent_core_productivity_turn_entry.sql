-- Prepared only. Authenticate history admission before the current engine writes or plans.
create function public.read_hermes_productivity_turn_entry(
  p_owner_id uuid, p_owner_token uuid, p_user_id uuid, p_request_id text, p_thread_id text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare owner_row record; prior_row record; prior jsonb;
begin
  if p_user_id is null then return null; end if;
  select id,message_id,thread_id,sequence_id,lease_expires_at,response into owner_row from public.hermes_inbound_turns where id=p_owner_id and lease_token=p_owner_token
    and message_id=p_request_id and thread_id=p_thread_id and status='running' and lease_expires_at>clock_timestamp() for update;
  if not found then return null; end if;
  if coalesce(owner_row.response,'{}'::jsonb) ?| array['agentCore','agentCoreProductivity','agentCoreResolution',
    'agentCoreActiveRun','agentCoreActiveResolution','agentCoreActiveCompletion','agentCoreDeliveryManifest','agentCoreBaseline']
    then return null; end if;
  -- A queued/running predecessor cannot be silently skipped, even when no unknown row exists.
  if exists(select 1 from public.hermes_inbound_turns where thread_id=p_thread_id and sequence_id<owner_row.sequence_id
    and status in ('queued','running')) then return null; end if;
  select id,message_id,thread_id,sequence_id,status,response into prior_row from public.hermes_inbound_turns where thread_id=p_thread_id and sequence_id<owner_row.sequence_id
    and status='unknown' order by sequence_id asc limit 1 for update;
  if not found then
    select id,message_id,thread_id,sequence_id,status,response into prior_row from public.hermes_inbound_turns where thread_id=p_thread_id and sequence_id<owner_row.sequence_id and status='completed'
      order by sequence_id desc limit 1 for update;
  end if;
  if found then
    prior:=jsonb_build_object('id',prior_row.id,'message_id',prior_row.message_id,'thread_id',prior_row.thread_id,
      'sequence_id',prior_row.sequence_id,'status',prior_row.status,'response',prior_row.response);
  end if;
  if not exists(select 1 from public.hermes_inbound_turns where id=p_owner_id and lease_token=p_owner_token
    and status='running' and lease_expires_at>clock_timestamp()) then return null; end if;
  return jsonb_build_object('anchor',jsonb_build_object('id',owner_row.id,'message_id',owner_row.message_id,
    'thread_id',owner_row.thread_id,'sequence_id',owner_row.sequence_id),'prior',prior);
end;
$$;
revoke execute on function public.read_hermes_productivity_turn_entry(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.read_hermes_productivity_turn_entry(uuid,uuid,uuid,text,text) to service_role;
