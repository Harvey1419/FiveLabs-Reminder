-- Hermes is a server-only application. The owner confirmed there are no
-- browser/mobile clients using anon/authenticated database access.
-- Existing service-role callers retain their data and RPC permissions.
revoke create on schema public from public, anon, authenticated;

do $$
declare table_name text; routine record;
begin
  foreach table_name in array array[
    'users', 'messages', 'memories', 'tasks', 'reminders', 'projects', 'entities',
    'subscriptions', 'user_integrations', 'agent_runs', 'prepared_actions',
    'agent_execution_events', 'hermes_inbound_turns'
  ] loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format('alter table public.%I enable row level security', table_name);
      execute format('revoke all on public.%I from public, anon, authenticated', table_name);
      execute format('grant select, insert, update, delete on public.%I to service_role', table_name);
    end if;
  end loop;

  -- Include every overload of the application's RPCs; extension functions stay intact.
  for routine in
    select p.oid::regprocedure as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in (
        'claim_next_pending_reminder', 'match_memories', 'rename_entity_cascade', 'merge_entities',
        'claim_hermes_inbound_turn', 'renew_hermes_inbound_turn',
        'checkpoint_hermes_inbound_turn', 'finish_hermes_inbound_turn', 'hermes_inbound_queue_version'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', routine.signature);
    execute format('grant execute on function %s to service_role', routine.signature);
    execute format('alter function %s set search_path = public, pg_temp', routine.signature);
  end loop;
end;
$$;
