-- Prepared only. Reads evidence; does not reopen runs, resolve turns or authorize replay.
create index if not exists hermes_inbound_recovery_order
  on public.hermes_inbound_turns(thread_id,sequence_id) where status in ('completed','unknown');
create function public.read_hermes_active_run_recovery(
  p_owner_id uuid, p_owner_token uuid, p_user_id uuid, p_request_id text, p_thread_id text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare owner_row public.hermes_inbound_turns; prior_row public.hermes_inbound_turns;
  run_row public.agent_runs; checkpoint jsonb; actions_json jsonb;
begin
  select * into owner_row from public.hermes_inbound_turns where id=p_owner_id and lease_token=p_owner_token
    and message_id=p_request_id and thread_id=p_thread_id and status='running'
    and lease_expires_at>clock_timestamp() for update;
  if not found then return null; end if;
  -- Never skip an uncertain old turn to choose a more convenient recent engine.
  select * into prior_row from public.hermes_inbound_turns where thread_id=p_thread_id
    and sequence_id<owner_row.sequence_id and status='unknown' order by sequence_id limit 1 for update;
  if not found then
    select * into prior_row from public.hermes_inbound_turns where thread_id=p_thread_id
      and sequence_id<owner_row.sequence_id and status in ('completed','unknown')
      order by sequence_id desc limit 1 for update;
  end if;
  if not found then
    if owner_row.lease_expires_at<=clock_timestamp() then return null; end if;
    return jsonb_build_object('absent',true);
  end if;
  if coalesce(prior_row.response ?| array['agentCore','agentCoreProductivity','agentCoreResolution','agentCoreActiveResolution'],false)
    or not coalesce(prior_row.response ? 'agentCoreActiveRun',false) then return null; end if;
  checkpoint := prior_row.response->'agentCoreActiveRun';
  if checkpoint->>'version' is distinct from '1' or coalesce(checkpoint->>'stage' not in ('claimed','final'),true)
    or checkpoint->>'userId' is distinct from p_user_id::text
    or checkpoint->>'inboundRunId' is distinct from prior_row.id::text
    or checkpoint->>'requestId' is distinct from prior_row.message_id then return null; end if;
  select * into run_row from public.agent_runs where id=(checkpoint->>'runId')::uuid
    and user_id=p_user_id and thread_id=p_thread_id for update;
  if not found then return null; end if;
  perform 1 from public.prepared_actions where run_id=run_row.id order by call_id collate "C" limit 13 for update;
  select coalesce(jsonb_agg(jsonb_build_object('callId',a.call_id,'domain',a.domain,'action',a.action,
    'targetId',a.target_id::text,'targetName',a.target_name,'payload',a.payload,'status',a.status,
    'executionFact',a.execution_fact) order by a.call_id collate "C"),'[]'::jsonb)
    into actions_json from (select * from public.prepared_actions where run_id=run_row.id
      order by call_id collate "C" limit 13) a;
  -- Run expiry does not erase historical evidence; only the current recovery lease must remain live.
  if owner_row.lease_expires_at<=clock_timestamp() then return null; end if;
  return jsonb_build_object('anchor',jsonb_build_object('id',owner_row.id::text,'message_id',owner_row.message_id,
    'thread_id',owner_row.thread_id,'sequence_id',owner_row.sequence_id),
    'prior',jsonb_build_object('id',prior_row.id::text,'message_id',prior_row.message_id,
    'thread_id',prior_row.thread_id,'sequence_id',prior_row.sequence_id,'status',prior_row.status,'response',prior_row.response),
    'run',jsonb_build_object('id',run_row.id::text,'user_id',run_row.user_id::text,'thread_id',run_row.thread_id,
      'status',run_row.status,'kind',run_row.kind,'context',coalesce(run_row.context,'{}'::jsonb),
      'waiting_for',run_row.waiting_for,'expires_at',run_row.expires_at), 'actions',actions_json);
exception when invalid_text_representation then return null;
end;
$$;
revoke execute on function public.read_hermes_active_run_recovery(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.read_hermes_active_run_recovery(uuid,uuid,uuid,text,text) to service_role;
