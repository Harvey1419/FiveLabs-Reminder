-- Prepared only. Closes historical work; never dispatches, sends, requeues or reopens it.
create function public.resolve_hermes_active_run(
  p_owner_id uuid,p_owner_token uuid,p_expected jsonb,p_resolution jsonb
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare current_snapshot jsonb; checkpoint jsonb; source_response jsonb; action jsonb; proof jsonb;
  target_id uuid; run_id uuid; user_id uuid; proof_count integer := 0; owner_expiry timestamptz;
begin
  if p_expected is null or jsonb_typeof(p_expected)<>'object' or p_resolution is null or jsonb_typeof(p_resolution)<>'object'
    or p_expected->'anchor'->>'id' is distinct from p_owner_id::text then return false; end if;
  user_id := (p_expected->'run'->>'user_id')::uuid;
  current_snapshot := public.read_hermes_active_run_recovery(p_owner_id,p_owner_token,user_id,
    p_expected->'anchor'->>'message_id',p_expected->'anchor'->>'thread_id');
  -- Nested reader holds owner/prior/run/action locks until this entire closure transaction ends.
  if current_snapshot is null or current_snapshot is distinct from p_expected then return false; end if;
  select lease_expires_at into owner_expiry from public.hermes_inbound_turns where id=p_owner_id
    and not coalesce(response ?| array['agentCore','agentCoreProductivity','agentCoreActiveRun','agentCoreActiveResolution','agentCoreActiveCompletion'],false);
  if not found then return false; end if;
  target_id := (p_expected->'prior'->>'id')::uuid; run_id := (p_expected->'run'->>'id')::uuid;
  source_response := p_expected->'prior'->'response'; checkpoint := source_response->'agentCoreActiveRun';
  if coalesce(source_response ?| array['agentCoreActiveResolution','agentCoreActiveCompletion'],false)
    or p_resolution->>'version' is distinct from '1' or p_resolution->>'kind' is distinct from 'active_run_handoff'
    or p_resolution->'grantsExecution' is distinct from 'false'::jsonb
    or p_resolution->>'userId' is distinct from user_id::text
    or p_resolution->>'runId' is distinct from target_id::text
    or p_resolution->>'activeRunId' is distinct from run_id::text
    or p_resolution->>'requestId' is distinct from p_expected->'prior'->>'message_id'
    or p_resolution->>'threadId' is distinct from p_expected->'prior'->>'thread_id'
    or p_resolution->>'claimId' is distinct from checkpoint->>'claimId'
    or p_resolution->'source' is distinct from p_expected
    or coalesce(p_resolution->>'sourceFingerprint','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_resolution->>'snapshotFingerprint','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_resolution->>'runStatus' not in ('completed','cancelled','failed'),true)
    or p_resolution->'conversation'->>'userId' is distinct from user_id::text
    or p_resolution->'baseline'->>'userId' is distinct from user_id::text
    or not coalesce(p_resolution->'conversation'->'handledRequestIds' ? (p_expected->'prior'->>'message_id'),false)
    or jsonb_typeof(p_resolution->'effects') is distinct from 'array' then return false; end if;
  for action in select value from jsonb_array_elements(p_expected->'actions') loop
    if action->>'status'='prepared' or coalesce(action->>'domain' not in ('task','reminder','calendar'),true) then return false; end if;
    if action->>'status' in ('executed','failed') or action->'executionFact' is distinct from 'null'::jsonb then
      proof_count := proof_count+1;
      if (select count(*) from jsonb_array_elements(p_resolution->'effects') e where e->>'callId'=action->>'callId')<>1 then return false; end if;
    end if;
  end loop;
  if proof_count<>jsonb_array_length(p_resolution->'effects') then return false; end if;
  for proof in select value from jsonb_array_elements(p_resolution->'effects') loop
    if proof->>'userId' is distinct from user_id::text or proof->>'activeRunId' is distinct from run_id::text
      or proof->'coversCompanions' is distinct from 'true'::jsonb
      or coalesce(proof->>'actionFingerprint','') !~ '^[a-f0-9]{64}$' or coalesce(proof->>'evidenceId','')=''
      or coalesce(proof->>'outcome' not in ('applied','no_effect'),true) then return false; end if;
    if proof->>'outcome'='applied' then
      if proof->'item'->>'callId' is distinct from proof->>'callId' or proof->'item'->>'status' is distinct from 'success'
        or proof->'item'->'result'->'complete' is distinct from 'true'::jsonb then return false; end if;
    elsif proof->'item' is distinct from 'null'::jsonb then return false;
    end if;
  end loop;
  proof := p_resolution->'delivery';
  if proof->>'userId' is distinct from user_id::text or proof->>'inboundRunId' is distinct from target_id::text
    or proof->>'sourceFingerprint' is distinct from p_resolution->>'sourceFingerprint' or coalesce(proof->>'evidenceId','')=''
    or coalesce(proof->>'outcome' not in ('accepted','not_sent'),true)
    or jsonb_typeof(proof->'messageIds') is distinct from 'array' then return false; end if;
  if (proof->>'outcome'='accepted') is distinct from (jsonb_array_length(proof->'messageIds')>0) then return false; end if;
  if checkpoint->>'stage'='claimed' and p_expected->'run'->'context'->'_agentCoreClaim' is distinct from
    jsonb_build_object('claimId',checkpoint->>'claimId','ownerId',target_id::text,'source',checkpoint->'snapshot') then return false; end if;
  if owner_expiry<=clock_timestamp() then return false; end if;
  update public.agent_runs set status=p_resolution->>'runStatus',context=context-'_agentCoreClaim',waiting_for=null,
    updated_at=clock_timestamp() where id=run_id;
  update public.hermes_inbound_turns set status='completed',finished_at=coalesce(finished_at,clock_timestamp()),
    response=source_response||jsonb_build_object('agentCoreActiveResolution',p_resolution) where id=target_id;
  return true;
exception when invalid_text_representation then return false;
end;
$$;
revoke execute on function public.resolve_hermes_active_run(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.resolve_hermes_active_run(uuid,uuid,jsonb,jsonb) to service_role;
