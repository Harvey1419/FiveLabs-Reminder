-- Run against the isolated minimal schema and migration, never against production.
do $$
declare owner_id uuid:=gen_random_uuid(); first_id uuid:=gen_random_uuid(); second_id uuid:=gen_random_uuid();
 original jsonb:='{"delivery":{"status":"attempted"},"confirmation":"original evidence","executionFacts":[{"tool":"manage_task","action":"listed_tasks","outcome":"success","success":true}]}';
 lease jsonb; proof jsonb:='{"source":"railway_provider_error_log","provider":"Kapso","httpStatus":400,"providerCode":100,"message":"Param text.body must be at most 4096 characters long.","correlationId":"11111111-1111-4111-8111-111111111111","loggedAtUtc":"2026-10-13T03:47:16Z"}';
begin
 original:=jsonb_set(original,'{confirmation}',to_jsonb(repeat('x',4857)));
 insert into public.users values(owner_id,'fixture-thread');
 insert into public.hermes_inbound_turns(id,message_id,thread_id,status,response,last_error) values
 (first_id,'first','fixture-thread','unknown',original,'VALIDATION_ERROR'),(second_id,'second','fixture-thread','unknown',original,'VALIDATION_ERROR');
 if public.lease_hermes_rejected_transport_turn(first_id,gen_random_uuid(),original) is not null then raise exception 'foreign owner acquired lease'; end if;
 if public.lease_hermes_rejected_transport_turn(first_id,owner_id,original||'{"changed":true}') is not null then raise exception 'changed response acquired lease'; end if;
 update public.hermes_inbound_turns set response=jsonb_set(original,'{executionFacts}','[{"success":true,"outcome":"success"}]') where id=first_id;
 if public.lease_hermes_rejected_transport_turn(first_id,owner_id,(select response from public.hermes_inbound_turns where id=first_id)) is not null then raise exception 'missing tool admitted'; end if;
 update public.hermes_inbound_turns set response=original where id=first_id;
 lease:=public.lease_hermes_rejected_transport_turn(first_id,owner_id,original);
 if lease is null then raise exception 'valid lease unavailable'; end if;
 if public.lease_hermes_rejected_transport_turn(second_id,owner_id,original) is not null then raise exception 'second running owner admitted'; end if;
 if public.resolve_hermes_rejected_transport_turn(first_id,gen_random_uuid(),second_id,owner_id,original,proof) then raise exception 'foreign token resolved'; end if;
 if public.resolve_hermes_rejected_transport_turn(first_id,(lease->>'token')::uuid,second_id,owner_id,original,proof||'{"httpStatus":500}') then raise exception 'uncertain rejection resolved'; end if;
 if public.resolve_hermes_rejected_transport_turn(first_id,(lease->>'token')::uuid,second_id,owner_id,original||'{"changed":true}',proof) then raise exception 'stale fingerprint resolved'; end if;
 update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()-interval '1 second' where id=first_id;
 if public.resolve_hermes_rejected_transport_turn(first_id,(lease->>'token')::uuid,second_id,owner_id,original,proof) then raise exception 'expired lease resolved'; end if;
 update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()+interval '1 minute' where id=first_id;
 if not public.resolve_hermes_rejected_transport_turn(first_id,(lease->>'token')::uuid,second_id,owner_id,original,proof) then raise exception 'valid second resolution failed'; end if;
 if not public.resolve_hermes_rejected_transport_turn(first_id,(lease->>'token')::uuid,first_id,owner_id,original,proof) then raise exception 'valid owner resolution failed'; end if;
 if exists(select 1 from public.hermes_inbound_turns where thread_id='fixture-thread' and status<>'completed') then raise exception 'thread not completed'; end if;
 if (select response-'agentCoreTransportRejected' from public.hermes_inbound_turns where id=second_id)<>original then raise exception 'original evidence changed'; end if;
 if public.resolve_hermes_rejected_transport_turn(first_id,(lease->>'token')::uuid,second_id,owner_id,original,proof) then raise exception 'closed owner replayed'; end if;
 if has_function_privilege('anon','public.lease_hermes_rejected_transport_turn(uuid,uuid,jsonb)','execute') then raise exception 'anonymous recovery access'; end if;
 raise notice 'Rejected transport recovery: ownership, fingerprints, explicit rejection, exclusivity, lease expiry, evidence preservation and no replay passed';
end; $$;
