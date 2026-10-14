do $$
declare owner public.hermes_inbound_turns; earlier public.hermes_inbound_turns; older public.hermes_inbound_turns;
  u uuid:=gen_random_uuid(); entry jsonb; thread text:='entry-fixture';
begin
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at)
    values('entry-genesis',thread,'{}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into owner;
  entry:=public.read_hermes_productivity_turn_entry(owner.id,owner.lease_token,u,owner.message_id,thread);
  assert entry->'prior'='null'::jsonb,'Only authenticated absence admits genesis';
  assert entry->'anchor'->>'id'=owner.id::text and entry->'anchor'->>'sequence_id'=owner.sequence_id::text,'Anchor binds exact current order';
  assert not entry::text like '%lease_token%' and not entry::text like '%request"%','Projection excludes credentials and inbound request';
  assert public.read_hermes_productivity_turn_entry(owner.id,gen_random_uuid(),u,owner.message_id,thread) is null,'Bad owner token denied';
  assert public.read_hermes_productivity_turn_entry(owner.id,owner.lease_token,null,owner.message_id,thread) is null,'Missing user denied';
  assert public.read_hermes_productivity_turn_entry(owner.id,owner.lease_token,u,'other',thread) is null,'Wrong request denied';
  assert public.read_hermes_productivity_turn_entry(owner.id,owner.lease_token,u,owner.message_id,'other') is null,'Wrong thread denied';
  update public.hermes_inbound_turns set response='{"agentCoreResolution":{}}' where id=owner.id;
  assert public.read_hermes_productivity_turn_entry(owner.id,owner.lease_token,u,owner.message_id,thread) is null,'Current namespace forbids late admission';
  update public.hermes_inbound_turns set response=null,lease_expires_at=clock_timestamp()-interval '1 second' where id=owner.id;
  assert public.read_hermes_productivity_turn_entry(owner.id,owner.lease_token,u,owner.message_id,thread) is null,'Expired lease denied';
  update public.hermes_inbound_turns set status='completed',lease_token=null,lease_expires_at=null,response='{"history":"oldest"}' where id=owner.id;
  older:=owner;
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,response) values('entry-prior',thread,'{}','completed','{"history":"latest"}') returning * into earlier;
  insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at)
    values('entry-current',thread,'{}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into owner;
  entry:=public.read_hermes_productivity_turn_entry(owner.id,owner.lease_token,u,owner.message_id,thread);
  assert entry->'prior'->>'id'=earlier.id::text,'Latest completed predecessor selected';
  update public.hermes_inbound_turns set status='unknown' where id=older.id;
  entry:=public.read_hermes_productivity_turn_entry(owner.id,owner.lease_token,u,owner.message_id,thread);
  assert entry->'prior'->>'id'=older.id::text and entry->'prior'->>'status'='unknown','Old uncertainty outranks a later completed checkpoint';
  update public.hermes_inbound_turns set status='unknown' where id=earlier.id;
  assert public.read_hermes_productivity_turn_entry(owner.id,owner.lease_token,u,owner.message_id,thread)->'prior'->>'id'=older.id::text,'Oldest unknown selected across all predecessors';
  update public.hermes_inbound_turns set status='queued' where id=earlier.id;
  assert public.read_hermes_productivity_turn_entry(owner.id,owner.lease_token,u,owner.message_id,thread) is null,'Queued predecessor blocks even with an unknown';
  update public.hermes_inbound_turns set status='completed' where id=older.id;
  assert public.read_hermes_productivity_turn_entry(owner.id,owner.lease_token,u,owner.message_id,thread) is null,'Queued predecessor cannot become genesis';
  update public.hermes_inbound_turns set status='completed' where id=earlier.id;
  perform public.read_hermes_productivity_turn_entry(owner.id,owner.lease_token,u,owner.message_id,thread);
  assert (select status='running' and response is null and lease_token=owner.lease_token from public.hermes_inbound_turns where id=owner.id),'Entry reads do not mutate the current owner';
  assert not has_function_privilege('anon','public.read_hermes_productivity_turn_entry(uuid,uuid,uuid,text,text)','execute'),'Anonymous execution denied';
  assert not has_function_privilege('authenticated','public.read_hermes_productivity_turn_entry(uuid,uuid,uuid,text,text)','execute'),'Authenticated execution denied';
  assert has_function_privilege('service_role','public.read_hermes_productivity_turn_entry(uuid,uuid,uuid,text,text)','execute'),'Backend execution granted';
  assert (select not prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='public.read_hermes_productivity_turn_entry(uuid,uuid,uuid,text,text)'::regprocedure),'Invoker with empty search path';
end;
$$;
