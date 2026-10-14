-- Administrative recovery of explicitly rejected, read-only baseline deliveries.
-- Never enqueue or replay the old message. Both RPCs are service-only and invoker-secured.
create function public.lease_hermes_rejected_transport_turn(p_target_id uuid, p_user_id uuid, p_expected_response jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare target public.hermes_inbound_turns; token uuid := gen_random_uuid();
begin
  select * into target from public.hermes_inbound_turns where id=p_target_id for update;
  if not found or target.status <> 'unknown' or target.last_error is distinct from 'VALIDATION_ERROR'
    or target.response is distinct from p_expected_response
    or target.response->'delivery'->>'status' is distinct from 'attempted'
    or coalesce(char_length(target.response->>'confirmation'),0)<=4096
    or jsonb_typeof(target.response->'executionFacts') is distinct from 'array'
    or jsonb_array_length(target.response->'executionFacts') = 0
    or exists(select 1 from jsonb_array_elements(target.response->'executionFacts') f where
      not coalesce(((f->>'tool'='manage_task' and f->>'action'='listed_tasks')
        or (f->>'tool'='manage_project' and f->>'action'='listed_projects')),false)
      or (f->>'outcome') is distinct from 'success' or (f->>'success') is distinct from 'true')
    or target.response ?| array['agentCore','agentCoreProductivity','agentCoreActiveRun','agentCoreTransportRejected','transportRecoveryLease']
    or not exists(select 1 from public.users u where u.id=p_user_id and u.phone_number=target.thread_id)
    or exists(select 1 from public.hermes_inbound_turns t where t.thread_id=target.thread_id and t.status='running') then return null; end if;
  update public.hermes_inbound_turns set status='running',lease_token=token,
    lease_expires_at=clock_timestamp()+interval '5 minutes',
    response=response||jsonb_build_object('transportRecoveryLease',jsonb_build_object(
      'version',1,'userId',p_user_id,'purpose','explicit_rejected_read_only_delivery','token',token,
      'acquiredAt',clock_timestamp(),'sourceFingerprint',encode(extensions.digest(p_expected_response::text,'sha256'),'hex')))
    where id=p_target_id;
  return jsonb_build_object('ownerId',p_target_id,'token',token,'threadId',target.thread_id);
exception when unique_violation then return null;
end; $$;

create function public.resolve_hermes_rejected_transport_turn(p_owner_id uuid,p_owner_token uuid,
  p_target_id uuid,p_user_id uuid,p_expected_response jsonb,p_rejection jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare owner public.hermes_inbound_turns; target public.hermes_inbound_turns; original jsonb; resolution jsonb;
begin
  select * into owner from public.hermes_inbound_turns where id=p_owner_id and status='running'
    and lease_token=p_owner_token and lease_expires_at>clock_timestamp() for update;
  if not found or owner.response->'transportRecoveryLease'->>'userId' is distinct from p_user_id::text then return false; end if;
  select * into target from public.hermes_inbound_turns where id=p_target_id and thread_id=owner.thread_id for update;
  if not found or (target.id<>owner.id and target.status<>'unknown') or target.last_error is distinct from 'VALIDATION_ERROR' then return false; end if;
  original := case when target.id=owner.id then target.response-'transportRecoveryLease' else target.response end;
  if original is distinct from p_expected_response or original->'delivery'->>'status' is distinct from 'attempted'
    or coalesce(char_length(original->>'confirmation'),0)<=4096
    or jsonb_typeof(original->'executionFacts') is distinct from 'array'
    or jsonb_array_length(original->'executionFacts')=0
    or exists(select 1 from jsonb_array_elements(original->'executionFacts') f where
      not coalesce(((f->>'tool'='manage_task' and f->>'action'='listed_tasks')
        or (f->>'tool'='manage_project' and f->>'action'='listed_projects')),false)
      or (f->>'outcome') is distinct from 'success' or (f->>'success') is distinct from 'true')
    or original ?| array['agentCore','agentCoreProductivity','agentCoreActiveRun','agentCoreTransportRejected','transportRecoveryLease']
    or not exists(select 1 from public.users u where u.id=p_user_id and u.phone_number=target.thread_id)
    or jsonb_typeof(p_rejection) is distinct from 'object'
    or p_rejection->>'source' is distinct from 'railway_provider_error_log'
    or p_rejection->>'provider' is distinct from 'Kapso' or p_rejection->>'httpStatus' is distinct from '400'
    or p_rejection->>'providerCode' is distinct from '100'
    or p_rejection->>'message' is distinct from 'Param text.body must be at most 4096 characters long.'
    or coalesce(p_rejection->>'correlationId','') !~ '^[a-f0-9-]{36}$'
    or coalesce(p_rejection->>'loggedAtUtc','')='' then return false; end if;
  -- A lock wait must not outlive the lease that authorizes this recovery.
  if owner.lease_expires_at<=clock_timestamp() then return false; end if;
  resolution := jsonb_build_object('version',1,'userId',p_user_id,'runId',target.id,'requestId',target.message_id,
    'threadId',target.thread_id,'effects','read_only','delivery','rejected','leaseOwnerId',owner.id,
    'sourceFingerprint',encode(extensions.digest(original::text,'sha256'),'hex'),
    'rejection',p_rejection,'resolvedAtUtc',clock_timestamp());
  update public.hermes_inbound_turns set status='completed',finished_at=clock_timestamp(),
    response=response||jsonb_build_object('agentCoreTransportRejected',resolution),
    lease_expires_at=case when id=owner.id then null else lease_expires_at end
    where id=target.id;
  return true;
end; $$;
revoke execute on function public.lease_hermes_rejected_transport_turn(uuid,uuid,jsonb) from public,anon,authenticated;
revoke execute on function public.resolve_hermes_rejected_transport_turn(uuid,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.lease_hermes_rejected_transport_turn(uuid,uuid,jsonb) to service_role;
grant execute on function public.resolve_hermes_rejected_transport_turn(uuid,uuid,uuid,uuid,jsonb,jsonb) to service_role;
