-- Service-only, optimistic closure of a prior turn under the current thread lease.
-- Keep original execution/delivery evidence; never requeue or resend anything.
create function public.resolve_hermes_prior_turn(
  p_owner_id uuid, p_owner_token uuid, p_target_id uuid,
  p_expected_response jsonb, p_resolution jsonb
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare owner_row public.hermes_inbound_turns; target_row public.hermes_inbound_turns;
begin
  select * into owner_row from public.hermes_inbound_turns
    where id = p_owner_id and lease_token = p_owner_token and status = 'running'
      and lease_expires_at > clock_timestamp() for update;
  if not found then return false; end if;
  select * into target_row from public.hermes_inbound_turns
    where id = p_target_id and thread_id = owner_row.thread_id
      and sequence_id < owner_row.sequence_id and status in ('unknown', 'completed') for update;
  if not found or target_row.response is distinct from p_expected_response
    or coalesce(target_row.response ? 'agentCoreProductivity', false)
    or coalesce(target_row.response ? 'agentCoreActiveRun', false)
    or coalesce(target_row.response ? 'agentCoreActiveResolution', false)
    or coalesce(target_row.response ?| array['agentCoreDeliveryManifest','agentCoreBaseline','agentCoreActiveCompletion'], false)
    or coalesce(target_row.response ? 'agentCoreResolution', false) then return false; end if;
  if p_resolution is null or jsonb_typeof(p_resolution) <> 'object'
    or (p_resolution->>'version') is distinct from '1'
    or (p_resolution->>'runId') is distinct from target_row.id::text
    or (p_resolution->>'requestId') is distinct from target_row.message_id
    or (p_resolution->>'threadId') is distinct from target_row.thread_id
    or coalesce(p_resolution->>'userId', '') = ''
    or (p_resolution->'conversation'->>'userId') is distinct from (p_resolution->>'userId')
    or not coalesce((p_resolution->'conversation'->'handledRequestIds') ? target_row.message_id, false)
    or coalesce(p_resolution->>'sourceFingerprint', '') !~ '^[a-f0-9]{64}$'
    then return false; end if;
  if (p_resolution->>'kind') = 'reconciliation' then
    if target_row.status <> 'unknown' or (target_row.response->'agentCore'->>'version') is distinct from '2'
      or (target_row.response->'agentCore'->>'userId') is distinct from (p_resolution->>'userId') then return false; end if;
  elsif (p_resolution->>'kind') = 'legacy_handoff' then
    if target_row.status <> 'completed' or coalesce(target_row.response ? 'agentCore', false) then return false; end if;
  else return false;
  end if;
  -- A target row lock may have waited beyond the current worker's lease.
  if owner_row.lease_expires_at <= clock_timestamp() then return false; end if;
  update public.hermes_inbound_turns set status = 'completed',
    response = target_row.response || jsonb_build_object('agentCoreResolution', p_resolution),
    finished_at = coalesce(finished_at, clock_timestamp())
    where id = target_row.id;
  return true;
end;
$$;
revoke execute on function public.resolve_hermes_prior_turn(uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.resolve_hermes_prior_turn(uuid, uuid, uuid, jsonb, jsonb) to service_role;
