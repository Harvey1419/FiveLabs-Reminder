-- Prepared only. Certify accepted historical work without dispatch, replay or retiring the current owner.
create function public.resolve_hermes_interrupted_active_completion(
  p_owner_id uuid,p_owner_token uuid,p_user_id uuid,p_request_id text,p_thread_id text,p_expected jsonb,p_completion jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare owner_row public.hermes_inbound_turns; prior_row public.hermes_inbound_turns; run_row public.agent_runs; action_row public.prepared_actions;
  actual jsonb; baseline jsonb; baseline_projection jsonb; manifest jsonb; checkpoint jsonb; receipt jsonb; item jsonb;
  count_receipts integer:=0; marker jsonb; merged_tasks jsonb; record jsonb; task_index integer; conversation jsonb;
begin
  if jsonb_typeof(p_expected) is distinct from 'object' or jsonb_typeof(p_completion) is distinct from 'object' then return null; end if;
  actual:=public.read_hermes_interrupted_active_completion(p_owner_id,p_owner_token,p_user_id,p_request_id,p_thread_id);
  if actual is null or actual is distinct from p_expected or actual ? 'absent'
    or p_completion->'receipts' is distinct from actual->'receipts' then return null; end if;
  select * into owner_row from public.hermes_inbound_turns where id=p_owner_id and lease_token=p_owner_token
    and status='running' and message_id=p_request_id and thread_id=p_thread_id and lease_expires_at>clock_timestamp() for update;
  if not found or coalesce(owner_row.response ?| array['agentCore','agentCoreProductivity','agentCoreResolution','agentCoreActiveRun',
    'agentCoreActiveResolution','agentCoreActiveCompletion','agentCoreDeliveryManifest','agentCoreBaseline'],false) then return null; end if;
  select * into prior_row from public.hermes_inbound_turns where id=(actual->'snapshot'->'prior'->>'id')::uuid and status='unknown' for update;
  if not found or prior_row.thread_id<>p_thread_id or prior_row.sequence_id>=owner_row.sequence_id then return null; end if;
  checkpoint:=prior_row.response->'agentCoreActiveRun'; marker:=prior_row.response->'agentCoreBaseline';
  if checkpoint->>'stage' is distinct from 'final' or coalesce(checkpoint->'result'->>'status','') not in ('completed','cancelled')
    or p_completion->>'version' is distinct from '1' or p_completion->>'kind' is distinct from 'active_turn_completion'
    or p_completion->'sourceResponse' is distinct from prior_row.response
    or coalesce(p_completion->>'sourceFingerprint','') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_completion->'receipts') is distinct from 'array' then return null; end if;
  select * into run_row from public.agent_runs where id=(checkpoint->>'runId')::uuid and user_id=(checkpoint->>'userId')::uuid
    and thread_id=prior_row.thread_id for update;
  if not found or run_row.status is distinct from checkpoint->'result'->>'status' or coalesce(run_row.context ? '_agentCoreClaim',false)
    or run_row.kind is distinct from checkpoint->'snapshot'->'executionState'->>'kind'
    or run_row.expires_at is distinct from (checkpoint->'snapshot'->>'expiresAtIso')::timestamptz
    or coalesce(run_row.waiting_for,'null'::jsonb) is distinct from checkpoint->'snapshot'->'executionState'->'waitingFor'
    or run_row.context is distinct from checkpoint->'snapshot'->'executionState'->'context' then return null; end if;
  select b.receipt into baseline from public.hermes_owned_baselines b where b.inbound_run_id=prior_row.id and b.user_id=run_row.user_id;
  if not found or not baseline ? 'input' or marker->>'baselineId' is distinct from baseline->>'id' then return null; end if;
  baseline_projection:=jsonb_build_object('id',baseline->>'id','candidateFingerprint',marker->>'candidateFingerprint',
    'conversation',baseline->'conversation','input',baseline->'input')||((baseline->'candidate')-'prior'-'version');
  if p_completion->'baseline' is distinct from baseline_projection then return null; end if;
  select m.manifest into manifest from public.hermes_delivery_manifests m where m.inbound_run_id=prior_row.id and m.user_id=run_row.user_id for update;
  if not found or manifest is distinct from p_completion->'manifest'
    or prior_row.response->'agentCoreDeliveryManifest'->>'manifestId' is distinct from manifest->>'id'
    or manifest->'sourceResponse' is distinct from prior_row.response-'agentCoreDeliveryManifest'
    or jsonb_array_length(manifest->'entries')<>1 or exists(select 1 from jsonb_array_elements(manifest->'entries') e
      where e->>'state' is distinct from 'accepted' or e->'message'->>'kind' is distinct from 'text' or coalesce(e->>'providerMessageId','')='') then return null; end if;
  if (select count(*) from public.prepared_actions where run_id=run_row.id)<>jsonb_array_length(checkpoint->'snapshot'->'actions') then return null; end if;
  for action_row in select * from public.prepared_actions where run_id=run_row.id order by call_id collate "C" for update loop
    if action_row.domain<>'task' or checkpoint->'actions'->action_row.call_id is distinct from to_jsonb(action_row) then return null; end if;
    if action_row.status='skipped' and action_row.execution_fact is null then continue; end if;
    if action_row.status<>'executed' or action_row.domain<>'task' then return null; end if;
    select r.receipt into receipt from public.hermes_atomic_task_receipts r where r.user_id=run_row.user_id and r.run_id=run_row.id and r.call_id=action_row.call_id;
    if not found or (select count(*) from jsonb_array_elements(p_completion->'receipts') e where e=receipt)<>1 then return null; end if;
    count_receipts:=count_receipts+1;
  end loop;
  if count_receipts<>jsonb_array_length(p_completion->'receipts') or count_receipts=0 and run_row.status='completed' or count_receipts>0 and run_row.status='cancelled' then return null; end if;
  if p_completion->'conversation'->>'userId' is distinct from run_row.user_id::text
    or jsonb_typeof(p_completion->'conversation'->'history') is distinct from 'array'
    or not coalesce(p_completion->'conversation'->'handledRequestIds' ? prior_row.message_id,false) then return null; end if;
  -- History prefix and exact authenticated input/accepted reply cannot be replaced by caller prose.
  if jsonb_array_length(p_completion->'conversation'->'history')<>jsonb_array_length(baseline->'conversation'->'history')+2 then return null; end if;
  if exists(select 1 from jsonb_array_elements(baseline->'conversation'->'history') with ordinality h(entry,n)
    where p_completion->'conversation'->'history'->(n::integer-1) is distinct from entry) then return null; end if;
  if p_completion->'conversation'->'history'->-2 is distinct from jsonb_build_object('role','user','content',baseline->'input'->>'userText')
    or p_completion->'conversation'->'history'->-1 is distinct from jsonb_build_object('role','assistant','content',manifest->'entries'->0->'message'->>'text','toolCalls','[]'::jsonb) then return null; end if;
  -- Preserve every reference/handled ID and merge only the exact independent task outcome records.
  if jsonb_typeof(baseline->'conversation'->'tasks') is distinct from 'array'
    or jsonb_typeof(baseline->'conversation'->'handledRequestIds') is distinct from 'array' then return null; end if;
  merged_tasks:=baseline->'conversation'->'tasks';
  for receipt in select value from jsonb_array_elements(p_completion->'receipts') loop
    if receipt->'item'->>'domain' is distinct from 'tasks' or jsonb_array_length(receipt->'item'->'result'->'records')<>1 then return null; end if;
    record:=receipt->'item'->'result'->'records'->0;
    select n::integer-1 into task_index from jsonb_array_elements(merged_tasks) with ordinality t(value,n) where value->>'id'=record->>'id' limit 1;
    if task_index is null then merged_tasks:=merged_tasks||jsonb_build_array(record);
    else merged_tasks:=jsonb_set(merged_tasks,array[task_index::text],record); end if;
  end loop;
  conversation:=(baseline->'conversation')||jsonb_build_object('tasks',merged_tasks,
    'handledRequestIds',(baseline->'conversation'->'handledRequestIds')||jsonb_build_array(prior_row.message_id),
    'history',(baseline->'conversation'->'history')||jsonb_build_array(
      jsonb_build_object('role','user','content',baseline->'input'->>'userText'),
      jsonb_build_object('role','assistant','content',manifest->'entries'->0->'message'->>'text','toolCalls','[]'::jsonb)));
  if p_completion->'conversation' is distinct from conversation then return null; end if;
  if owner_row.lease_expires_at<=clock_timestamp() then return null; end if;
  update public.hermes_inbound_turns set response=response||jsonb_build_object('agentCoreActiveCompletion',p_completion),status='completed',
    finished_at=clock_timestamp(),last_error=null,request='{}'::jsonb,completion_lease_token=null,lease_token=null,lease_expires_at=null where id=prior_row.id
    returning * into prior_row;
  -- A slow trigger/write cannot publish after current ownership expires; roll back the entire statement.
  if owner_row.lease_expires_at<=clock_timestamp() then raise exception 'INTERRUPTED_COMPLETION_LEASE_EXPIRED' using errcode='40001'; end if;
  return jsonb_build_object('id',prior_row.id::text,'message_id',prior_row.message_id,'thread_id',prior_row.thread_id,
    'sequence_id',prior_row.sequence_id,'status',prior_row.status,'response',prior_row.response);
exception when invalid_text_representation then return null;
end;
$$;
revoke execute on function public.resolve_hermes_interrupted_active_completion(uuid,uuid,uuid,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.resolve_hermes_interrupted_active_completion(uuid,uuid,uuid,text,text,jsonb,jsonb) to service_role;

-- Lost reply observation is a read of the exact completed source/certificate, never a retry or lease receipt.
create function public.observe_hermes_interrupted_active_completion(
  p_owner_id uuid,p_owner_token uuid,p_user_id uuid,p_request_id text,p_thread_id text,p_expected jsonb,p_completion jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare owner_row public.hermes_inbound_turns; prior_row public.hermes_inbound_turns;
begin
  select * into owner_row from public.hermes_inbound_turns where id=p_owner_id and lease_token=p_owner_token
    and status='running' and message_id=p_request_id and thread_id=p_thread_id and lease_expires_at>clock_timestamp() for update;
  if not found or p_expected->'snapshot'->'anchor'->>'id' is distinct from owner_row.id::text
    or p_expected->'snapshot'->'anchor'->>'message_id' is distinct from owner_row.message_id
    or p_expected->'snapshot'->'anchor'->>'thread_id' is distinct from owner_row.thread_id
    or p_expected->'snapshot'->'anchor'->>'sequence_id' is distinct from owner_row.sequence_id::text then return null; end if;
  select * into prior_row from public.hermes_inbound_turns where id=(p_expected->'snapshot'->'prior'->>'id')::uuid
    and thread_id=p_thread_id and sequence_id<owner_row.sequence_id and status='completed' for share;
  if not found or prior_row.response->'agentCoreActiveCompletion' is distinct from p_completion
    or prior_row.response-'agentCoreActiveCompletion' is distinct from p_expected->'snapshot'->'prior'->'response'
    or p_completion->'baseline'->>'userId' is distinct from p_user_id::text
    or p_completion->'baseline'->>'inboundRunId' is distinct from prior_row.id::text
    or p_completion->'baseline'->>'requestId' is distinct from prior_row.message_id
    or p_completion->'baseline'->>'threadId' is distinct from prior_row.thread_id
    or p_completion->'baseline'->>'sequenceId' is distinct from prior_row.sequence_id::text then return null; end if;
  if owner_row.lease_expires_at<=clock_timestamp() then return null; end if;
  return jsonb_build_object('id',prior_row.id::text,'message_id',prior_row.message_id,'thread_id',prior_row.thread_id,
    'sequence_id',prior_row.sequence_id,'status',prior_row.status,'response',prior_row.response);
exception when invalid_text_representation then return null;
end;
$$;
revoke execute on function public.observe_hermes_interrupted_active_completion(uuid,uuid,uuid,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.observe_hermes_interrupted_active_completion(uuid,uuid,uuid,text,text,jsonb,jsonb) to service_role;
