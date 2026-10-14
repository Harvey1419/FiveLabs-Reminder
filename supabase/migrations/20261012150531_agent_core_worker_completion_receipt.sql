-- Prepared only. The retired token is a private completion receipt key, never an active grant.
alter table public.hermes_inbound_turns add column completion_lease_token uuid;

create or replace function public.finish_hermes_active_turn(p_owner_id uuid,p_owner_token uuid,p_expected jsonb,p_completion jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare owner_row public.hermes_inbound_turns; run_row public.agent_runs; action_row public.prepared_actions;
  baseline jsonb; baseline_projection jsonb; manifest jsonb; checkpoint jsonb; receipt jsonb; item jsonb; count_receipts integer:=0; marker jsonb;
begin
  if jsonb_typeof(p_expected) is distinct from 'object' or jsonb_typeof(p_completion) is distinct from 'object' then return false; end if;
  select * into owner_row from public.hermes_inbound_turns where id=p_owner_id and lease_token=p_owner_token and status='running'
    and lease_expires_at>clock_timestamp() for update;
  if not found or owner_row.response is distinct from p_expected or coalesce(owner_row.response ? 'agentCoreActiveCompletion',false) then return false; end if;
  checkpoint:=owner_row.response->'agentCoreActiveRun'; marker:=owner_row.response->'agentCoreBaseline';
  if checkpoint->>'stage' is distinct from 'final' or coalesce(checkpoint->'result'->>'status','') not in ('completed','cancelled')
    or p_completion->>'version' is distinct from '1' or p_completion->>'kind' is distinct from 'active_turn_completion'
    or p_completion->'sourceResponse' is distinct from owner_row.response
    or coalesce(p_completion->>'sourceFingerprint','') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_completion->'receipts') is distinct from 'array' then return false; end if;
  select * into run_row from public.agent_runs where id=(checkpoint->>'runId')::uuid and user_id=(checkpoint->>'userId')::uuid
    and thread_id=owner_row.thread_id for update;
  if not found or run_row.status is distinct from checkpoint->'result'->>'status' or coalesce(run_row.context ? '_agentCoreClaim',false)
    or run_row.kind is distinct from checkpoint->'snapshot'->'executionState'->>'kind'
    or run_row.expires_at is distinct from (checkpoint->'snapshot'->>'expiresAtIso')::timestamptz
    or coalesce(run_row.waiting_for,'null'::jsonb) is distinct from checkpoint->'snapshot'->'executionState'->'waitingFor'
    or run_row.context is distinct from checkpoint->'snapshot'->'executionState'->'context' then return false; end if;
  select b.receipt into baseline from public.hermes_owned_baselines b where b.inbound_run_id=owner_row.id and b.user_id=run_row.user_id;
  if not found or not baseline ? 'input' or marker->>'baselineId' is distinct from baseline->>'id' then return false; end if;
  baseline_projection:=jsonb_build_object('id',baseline->>'id','candidateFingerprint',marker->>'candidateFingerprint',
    'conversation',baseline->'conversation','input',baseline->'input')||((baseline->'candidate')-'prior'-'version');
  if p_completion->'baseline' is distinct from baseline_projection then return false; end if;
  select m.manifest into manifest from public.hermes_delivery_manifests m where m.inbound_run_id=owner_row.id and m.user_id=run_row.user_id for update;
  if not found or manifest is distinct from p_completion->'manifest'
    or owner_row.response->'agentCoreDeliveryManifest'->>'manifestId' is distinct from manifest->>'id'
    or manifest->'sourceResponse' is distinct from owner_row.response-'agentCoreDeliveryManifest'
    or jsonb_array_length(manifest->'entries')<>1 or exists(select 1 from jsonb_array_elements(manifest->'entries') e
      where e->>'state' is distinct from 'accepted' or e->'message'->>'kind' is distinct from 'text' or coalesce(e->>'providerMessageId','')='') then return false; end if;
  if (select count(*) from public.prepared_actions where run_id=run_row.id)<>jsonb_array_length(checkpoint->'snapshot'->'actions') then return false; end if;
  for action_row in select * from public.prepared_actions where run_id=run_row.id order by call_id collate "C" for update loop
    if action_row.domain<>'task' or checkpoint->'actions'->action_row.call_id is distinct from to_jsonb(action_row) then return false; end if;
    if action_row.status='skipped' and action_row.execution_fact is null then continue; end if;
    if action_row.status<>'executed' or action_row.domain<>'task' then return false; end if;
    select r.receipt into receipt from public.hermes_atomic_task_receipts r where r.user_id=run_row.user_id and r.run_id=run_row.id and r.call_id=action_row.call_id;
    if not found or (select count(*) from jsonb_array_elements(p_completion->'receipts') e where e=receipt)<>1 then return false; end if;
    count_receipts:=count_receipts+1;
  end loop;
  if count_receipts<>jsonb_array_length(p_completion->'receipts') or count_receipts=0 and run_row.status='completed' or count_receipts>0 and run_row.status='cancelled' then return false; end if;
  if p_completion->'conversation'->>'userId' is distinct from run_row.user_id::text
    or jsonb_typeof(p_completion->'conversation'->'history') is distinct from 'array'
    or not coalesce(p_completion->'conversation'->'handledRequestIds' ? owner_row.message_id,false) then return false; end if;
  -- History prefix and exact authenticated input/accepted reply cannot be replaced by caller prose.
  if jsonb_array_length(p_completion->'conversation'->'history')<>jsonb_array_length(baseline->'conversation'->'history')+2 then return false; end if;
  if exists(select 1 from jsonb_array_elements(baseline->'conversation'->'history') with ordinality h(entry,n)
    where p_completion->'conversation'->'history'->(n::integer-1) is distinct from entry) then return false; end if;
  if p_completion->'conversation'->'history'->-2 is distinct from jsonb_build_object('role','user','content',baseline->'input'->>'userText')
    or p_completion->'conversation'->'history'->-1 is distinct from jsonb_build_object('role','assistant','content',manifest->'entries'->0->'message'->>'text','toolCalls','[]'::jsonb) then return false; end if;
  if owner_row.lease_expires_at<=clock_timestamp() then return false; end if;
  update public.hermes_inbound_turns set response=response||jsonb_build_object('agentCoreActiveCompletion',p_completion),status='completed',
    finished_at=clock_timestamp(),last_error=null,request='{}'::jsonb,completion_lease_token=owner_row.lease_token,lease_token=null,lease_expires_at=null where id=owner_row.id;
  if owner_row.lease_expires_at<=clock_timestamp() then raise exception 'ACTIVE_COMPLETION_LEASE_EXPIRED' using errcode='40001'; end if;
  return true;
exception when invalid_text_representation then return false;
end;
$$;
revoke execute on function public.finish_hermes_active_turn(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.finish_hermes_active_turn(uuid,uuid,jsonb,jsonb) to service_role;

create function public.was_completed_hermes_active_turn(p_id uuid,p_token uuid)
returns boolean language sql security invoker set search_path = '' as $$
  select exists(select 1 from public.hermes_inbound_turns q where q.id=p_id and q.completion_lease_token=p_token and q.status='completed'
    and q.lease_token is null and q.response->'agentCoreActiveCompletion'->>'kind'='active_turn_completion'
    and q.response->'agentCoreActiveCompletion'->'baseline'->>'inboundRunId'=q.id::text
    and q.response->'agentCoreActiveCompletion'->'baseline'->>'requestId'=q.message_id
    and q.response->'agentCoreActiveCompletion'->'baseline'->>'threadId'=q.thread_id
    and q.response->'agentCoreActiveCompletion'->'baseline'->>'sequenceId'=q.sequence_id::text);
$$;
revoke execute on function public.was_completed_hermes_active_turn(uuid,uuid) from public,anon,authenticated;
grant execute on function public.was_completed_hermes_active_turn(uuid,uuid) to service_role;
