-- Service-only inbox: acknowledge a webhook only after this row is durable.
-- A running turn is never retried automatically after an uncertain interruption.
create table public.hermes_inbound_turns (
  id uuid primary key default gen_random_uuid(),
  sequence_id bigint generated always as identity unique,
  message_id text not null unique,
  thread_id text not null,
  request jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'unknown')),
  lease_token uuid,
  lease_expires_at timestamptz,
  response jsonb,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz
);
alter table public.hermes_inbound_turns enable row level security;
revoke all on public.hermes_inbound_turns from public, anon, authenticated;
grant select, insert, update, delete on public.hermes_inbound_turns to service_role;
grant usage, select on sequence public.hermes_inbound_turns_sequence_id_seq to service_role;

create unique index hermes_one_running_turn_per_thread
  on public.hermes_inbound_turns(thread_id) where status = 'running';
create index hermes_inbound_queue_order
  on public.hermes_inbound_turns(sequence_id) where status = 'queued';
create index hermes_inbound_thread_order
  on public.hermes_inbound_turns(thread_id, sequence_id) where status in ('queued', 'running');

create function public.claim_hermes_inbound_turn(p_thread_id text default null)
returns setof public.hermes_inbound_turns
language plpgsql security invoker set search_path = '' as $$
declare candidate uuid;
begin
  -- Expired workers may have applied an effect. Preserve evidence; never requeue.
  update public.hermes_inbound_turns
  set status = 'unknown', finished_at = clock_timestamp(), last_error = 'WORKER_LEASE_EXPIRED'
  where status = 'running' and lease_expires_at <= clock_timestamp()
    and (p_thread_id is null or thread_id = p_thread_id);

  select q.id into candidate
  from public.hermes_inbound_turns q
  where q.status = 'queued' and (p_thread_id is null or q.thread_id = p_thread_id)
    and not exists (
      select 1 from public.hermes_inbound_turns earlier
      where earlier.thread_id = q.thread_id
        and earlier.status in ('queued', 'running')
        and earlier.sequence_id < q.sequence_id
    )
    and not exists (
      select 1 from public.hermes_inbound_turns active
      where active.thread_id = q.thread_id and active.status = 'running'
    )
  order by q.sequence_id for update of q skip locked limit 1;

  if candidate is null then return; end if;
  return query update public.hermes_inbound_turns
    set status = 'running', lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + interval '120 seconds'
    where id = candidate and status = 'queued' returning *;
end;
$$;

create function public.renew_hermes_inbound_turn(p_id uuid, p_token uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.hermes_inbound_turns
  set lease_expires_at = clock_timestamp() + interval '120 seconds'
  where id = p_id and lease_token = p_token and status = 'running'
    and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

create function public.checkpoint_hermes_inbound_turn(p_id uuid, p_token uuid, p_response jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.hermes_inbound_turns set response = coalesce(response, '{}'::jsonb) || p_response
  where id = p_id and lease_token = p_token and status = 'running'
    and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

create function public.finish_hermes_inbound_turn(p_id uuid, p_token uuid, p_status text, p_error text default null)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_status not in ('completed', 'unknown') then raise exception 'Invalid terminal turn status'; end if;
  update public.hermes_inbound_turns
  set status = p_status, last_error = left(p_error, 200), finished_at = clock_timestamp(),
      request = '{}'::jsonb
  where id = p_id and lease_token = p_token and status = 'running'
    and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

revoke execute on function public.claim_hermes_inbound_turn(text) from public, anon, authenticated;
revoke execute on function public.renew_hermes_inbound_turn(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.checkpoint_hermes_inbound_turn(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.finish_hermes_inbound_turn(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_hermes_inbound_turn(text) to service_role;
grant execute on function public.renew_hermes_inbound_turn(uuid, uuid) to service_role;
grant execute on function public.checkpoint_hermes_inbound_turn(uuid, uuid, jsonb) to service_role;
grant execute on function public.finish_hermes_inbound_turn(uuid, uuid, text, text) to service_role;

create function public.hermes_inbound_queue_version()
returns integer language sql stable security invoker set search_path = '' as $$ select 1; $$;
revoke execute on function public.hermes_inbound_queue_version() from public, anon, authenticated;
grant execute on function public.hermes_inbound_queue_version() to service_role;
