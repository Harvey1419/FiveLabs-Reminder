-- Prepared only: backend-owned approval/resume grants, not a production router activation.
create function public.agent_core_active_snapshot(p_run_id uuid, p_expiry_text text)
returns jsonb language sql security invoker set search_path = '' as $$
  select jsonb_build_object('runId', r.id::text, 'userId', r.user_id::text, 'threadId', r.thread_id,
    'status', r.status, 'expiresAtIso', p_expiry_text,
    'executionState', jsonb_build_object('kind',r.kind,'context',coalesce(r.context,'{}'::jsonb),'waitingFor',r.waiting_for),
    'actions',coalesce((select jsonb_agg(jsonb_build_object('callId',a.call_id,'domain',a.domain,'action',a.action,
      'targetId',a.target_id::text,'targetName',a.target_name,'payload',a.payload,'status',a.status,'executionFact',a.execution_fact)
      order by a.call_id collate "C") from public.prepared_actions a where a.run_id=r.id),'[]'::jsonb))
  from public.agent_runs r where r.id=p_run_id;
$$;

create function public.claim_hermes_active_run(
  p_owner_id uuid, p_owner_token uuid, p_expected jsonb, p_next_status text, p_decision jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare owner_row public.hermes_inbound_turns; run_row public.agent_runs;
  source jsonb; claim_id uuid := gen_random_uuid(); expiry_text text; checkpoint jsonb;
begin
  if p_expected is null or jsonb_typeof(p_expected)<>'object' or p_next_status is null or p_next_status not in ('running','cancelled')
    or p_decision is null or jsonb_typeof(p_decision)<>'object' then return null; end if;
  select * into owner_row from public.hermes_inbound_turns where id=p_owner_id and lease_token=p_owner_token
    and status='running' and lease_expires_at>clock_timestamp() for update;
  if not found or coalesce(owner_row.response ?| array['agentCore','agentCoreProductivity','agentCoreActiveRun','agentCoreActiveResolution','agentCoreActiveCompletion','agentCoreDeliveryManifest'],false)
    then return null; end if;
  if exists(select 1 from public.hermes_inbound_turns where thread_id=owner_row.thread_id
    and sequence_id<owner_row.sequence_id and status='unknown') then return null; end if;
  select * into run_row from public.agent_runs where id=(p_expected->>'runId')::uuid
    and user_id::text=p_expected->>'userId' and thread_id=owner_row.thread_id and thread_id=p_expected->>'threadId'
    and status in ('waiting_for_input','waiting_for_approval') and status=p_expected->>'status' for update;
  if not found or coalesce(run_row.context ? '_agentCoreClaim',false) then return null; end if;
  expiry_text := p_expected->>'expiresAtIso';
  if run_row.expires_at is distinct from expiry_text::timestamptz then return null; end if;
  perform 1 from public.prepared_actions where run_id=run_row.id order by call_id collate "C" for update;
  source := public.agent_core_active_snapshot(run_row.id,expiry_text);
  if source is distinct from p_expected or jsonb_array_length(source->'actions') not between 1 and 12
    or not exists(select 1 from public.prepared_actions where run_id=run_row.id and status='prepared')
    or exists(select 1 from public.prepared_actions where run_id=run_row.id and status='failed')
    or run_row.expires_at<=clock_timestamp() or owner_row.lease_expires_at<=clock_timestamp() then return null; end if;
  if p_next_status='cancelled' and not coalesce((p_decision->>'relation')='cancel' or (p_decision->>'decision')='reject',false) then return null; end if;
  checkpoint := jsonb_build_object('version',1,'stage','claimed','runId',run_row.id::text,'userId',run_row.user_id::text,
    'inboundRunId',owner_row.id::text,'requestId',owner_row.message_id,'snapshot',source,'decision',p_decision,'claimId',claim_id::text);
  update public.agent_runs set status=p_next_status,updated_at=clock_timestamp(),
    context=coalesce(context,'{}'::jsonb)||jsonb_build_object('_agentCoreClaim',jsonb_build_object('claimId',claim_id::text,
      'ownerId',owner_row.id::text,'source',source)) where id=run_row.id;
  update public.hermes_inbound_turns set response=coalesce(response,'{}'::jsonb)||jsonb_build_object('agentCoreActiveRun',checkpoint)
    where id=owner_row.id;
  return jsonb_build_object('claimId',claim_id::text,'snapshot',source,'status',p_next_status);
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then return null;
end;
$$;

create function public.mutate_hermes_active_run(
  p_owner_id uuid,p_owner_token uuid,p_run_id uuid,p_claim_id uuid,p_operation text,p_payload jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare owner_row public.hermes_inbound_turns; run_row public.agent_runs; action_row public.prepared_actions;
  claim jsonb; current_action jsonb; result_json jsonb; event_row public.agent_execution_events;
begin
  select * into owner_row from public.hermes_inbound_turns where id=p_owner_id and lease_token=p_owner_token
    and status='running' and lease_expires_at>clock_timestamp() for update;
  if not found then return null; end if;
  select * into run_row from public.agent_runs where id=p_run_id and thread_id=owner_row.thread_id for update;
  if not found then return null; end if;
  claim := run_row.context->'_agentCoreClaim';
  if claim->>'claimId' is distinct from p_claim_id::text or claim->>'ownerId' is distinct from owner_row.id::text
    or owner_row.response->'agentCoreActiveRun'->>'claimId' is distinct from p_claim_id::text
    or run_row.expires_at<=clock_timestamp() or owner_row.lease_expires_at<=clock_timestamp() then return null; end if;
  if p_operation in ('assert','action') and run_row.status not in ('running','cancelled') then return null; end if;
  if p_operation='assert' then return '{}'::jsonb; end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then return null; end if;
  if p_operation='action' then
    select * into action_row from public.prepared_actions where run_id=p_run_id and call_id=p_payload->>'callId' for update;
    if not found or not exists(select 1 from jsonb_array_elements(claim->'source'->'actions') a where a->>'callId'=action_row.call_id) then return null; end if;
    current_action := jsonb_build_object('callId',action_row.call_id,'domain',action_row.domain,'action',action_row.action,
      'targetId',action_row.target_id::text,'targetName',action_row.target_name,'payload',action_row.payload,
      'status',action_row.status,'executionFact',action_row.execution_fact);
    if current_action is distinct from p_payload->'expected' or (p_payload->'updates'->>'status') not in ('prepared','executed','skipped','failed')
      or owner_row.lease_expires_at<=clock_timestamp() or run_row.expires_at<=clock_timestamp() then return null; end if;
    update public.prepared_actions set status=p_payload->'updates'->>'status',execution_fact=p_payload->'updates'->'executionFact',
      payload=case when (p_payload->'updates') ? 'payload' then p_payload->'updates'->'payload' else payload end,
      executed_at=case when (p_payload->'updates'->>'status')='executed' then clock_timestamp() else null end
      where id=action_row.id returning * into action_row;
    result_json := to_jsonb(action_row);
    update public.hermes_inbound_turns set response=jsonb_set(response,'{agentCoreActiveRun,actions}',
      coalesce(response->'agentCoreActiveRun'->'actions','{}'::jsonb)||jsonb_build_object(action_row.call_id,to_jsonb(action_row))) where id=owner_row.id;
    return result_json;
  elsif p_operation='run' then
    if run_row.status not in ('running','cancelled') or p_payload->>'status' not in ('completed','failed','waiting_for_input','cancelled') then return null; end if;
    perform 1 from public.prepared_actions where run_id=p_run_id order by call_id collate "C" for update;
    if (select jsonb_agg(call_id order by call_id collate "C") from public.prepared_actions where run_id=p_run_id)
      is distinct from (select jsonb_agg(a->>'callId' order by a->>'callId' collate "C") from jsonb_array_elements(claim->'source'->'actions') a)
      or owner_row.lease_expires_at<=clock_timestamp() then return null; end if;
    update public.agent_runs set status=p_payload->>'status',updated_at=clock_timestamp(),
      waiting_for=case when p_payload ? 'waitingFor' then p_payload->'waitingFor' else waiting_for end where id=p_run_id returning * into run_row;
    return to_jsonb(run_row);
  elsif p_operation='event' then
    insert into public.agent_execution_events(run_id,user_id,thread_id,event_type,fact_payload)
      values(p_run_id,run_row.user_id,run_row.thread_id,p_payload->>'eventType',p_payload->'factPayload') returning * into event_row;
    return to_jsonb(event_row);
  elsif p_operation='finish' then
    if run_row.status='running' then return null; end if;
    update public.hermes_inbound_turns set response=jsonb_set(response,'{agentCoreActiveRun}',
      response->'agentCoreActiveRun'||jsonb_build_object('stage','final','result',p_payload)) where id=owner_row.id;
    update public.agent_runs set context=context-'_agentCoreClaim' where id=p_run_id;
    return '{}'::jsonb;
  end if;
  return null;
end;
$$;
revoke execute on function public.agent_core_active_snapshot(uuid,text) from public,anon,authenticated;
revoke execute on function public.claim_hermes_active_run(uuid,uuid,jsonb,text,jsonb) from public,anon,authenticated;
revoke execute on function public.mutate_hermes_active_run(uuid,uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.agent_core_active_snapshot(uuid,text) to service_role;
grant execute on function public.claim_hermes_active_run(uuid,uuid,jsonb,text,jsonb) to service_role;
grant execute on function public.mutate_hermes_active_run(uuid,uuid,uuid,uuid,text,jsonb) to service_role;
