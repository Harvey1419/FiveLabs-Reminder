-- Restore the prior accepted cancellation source from its actual ledger after the read-only tests.
do $$
declare prior public.hermes_inbound_turns; owner public.hermes_inbound_turns; u uuid; expected jsonb; completion jsonb;
  baseline jsonb; manifest jsonb; result jsonb; original_response jsonb; expired_write boolean:=false;
begin
  select q.* into prior from public.hermes_inbound_turns q join public.hermes_owned_baselines b on b.inbound_run_id=q.id
    join public.hermes_delivery_manifests m on m.inbound_run_id=q.id where m.manifest->'entries'->0->>'providerMessageId'='provider-final' order by q.sequence_id desc limit 1;
  select b.receipt into baseline from public.hermes_owned_baselines b where b.inbound_run_id=prior.id;
  select m.manifest into manifest from public.hermes_delivery_manifests m where m.inbound_run_id=prior.id;
  u:=(baseline->'candidate'->>'userId')::uuid;
  original_response:=(manifest->'sourceResponse')||jsonb_build_object('agentCoreDeliveryManifest',jsonb_build_object('version',1,'manifestId',manifest->>'id','sourceFingerprint',repeat('b',64)));
  update public.hermes_inbound_turns set status='unknown',response=original_response,request='{"retained":true}',last_error='interrupted' where id=prior.id;
  select * into owner from public.hermes_inbound_turns where thread_id=prior.thread_id and status='running' order by sequence_id desc limit 1;
  expected:=public.read_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id);
  assert expected is not null,'Actual source evidence available';
  completion:=jsonb_build_object('version',1,'kind','active_turn_completion','sourceFingerprint',repeat('c',64),'sourceResponse',original_response,
    'baseline',jsonb_build_object('id',baseline->>'id','candidateFingerprint',repeat('a',64),'input',baseline->'input','conversation',baseline->'conversation')||((baseline->'candidate')-'version'-'prior'),
    'manifest',manifest,'receipts','[]'::jsonb,
    'conversation',(baseline->'conversation')||jsonb_build_object('handledRequestIds',(baseline->'conversation'->'handledRequestIds')||jsonb_build_array(prior.message_id),
      'history',(baseline->'conversation'->'history')||jsonb_build_array(jsonb_build_object('role','user','content',baseline->'input'->>'userText'),
        jsonb_build_object('role','assistant','content',manifest->'entries'->0->'message'->>'text','toolCalls','[]'::jsonb))));
  assert public.resolve_hermes_interrupted_active_completion(owner.id,gen_random_uuid(),u,owner.message_id,owner.thread_id,expected,completion) is null,'Wrong owner token denied';
  assert public.resolve_hermes_interrupted_active_completion(owner.id,owner.lease_token,gen_random_uuid(),owner.message_id,owner.thread_id,expected,completion) is null,'Foreign user denied';
  assert public.resolve_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,'foreign',owner.thread_id,expected,completion) is null,'Foreign request denied';
  assert public.resolve_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,'foreign',expected,completion) is null,'Foreign thread denied';
  assert public.resolve_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id,expected||'{"changed":true}',completion) is null,'Full evidence CAS required';
  assert public.resolve_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id,expected,jsonb_set(completion,'{baseline,input,userText}','"Forged"')) is null,'Exact stored input required';
  assert public.resolve_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id,expected,jsonb_set(completion,'{manifest,entries,0,providerMessageId}','"Forged"')) is null,'Exact accepted manifest required';
  assert public.resolve_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id,expected,jsonb_set(completion,'{conversation,history,0,content}','"Forged"')) is null,'User history cannot be forged';
  assert public.resolve_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id,expected,jsonb_set(completion,'{conversation,events}','[{"id":"invented"}]')) is null,'Unrelated references must be retained';
  assert public.resolve_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id,expected,jsonb_set(completion,'{conversation,tasks}','[{"id":"invented"}]')) is null,'Only independent task outcomes enter references';
  assert public.resolve_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id,expected,jsonb_set(completion,'{conversation,handledRequestIds}',jsonb_build_array(prior.message_id,'invented'))) is null,'Handled IDs cannot be invented';
  update public.hermes_inbound_turns set response='{"agentCoreBaseline":{}}' where id=owner.id;
  assert public.resolve_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id,expected,completion) is null,'Recovery must precede current turn execution';
  update public.hermes_inbound_turns set response=null where id=owner.id;
  assert (select status='unknown' and response=original_response and request<>'{}'::jsonb from public.hermes_inbound_turns where id=prior.id),'Rejected closures leave history and cleanup untouched';
  update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()+interval '40 milliseconds' where id=owner.id;
  begin perform public.resolve_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id,expected,completion);
  exception when serialization_failure then expired_write:=true; end;
  assert expired_write,'Late lease expiry raises and rolls back publication';
  assert (select status='unknown' and response=original_response and request<>'{}'::jsonb from public.hermes_inbound_turns where id=prior.id),'Expired publication rolls back certificate status and cleanup';
  update public.hermes_inbound_turns set lease_expires_at=clock_timestamp()+interval '120 seconds' where id=owner.id;
  result:=public.resolve_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id,expected,completion);
  assert result->>'status'='completed' and result->'response'->'agentCoreActiveCompletion'=completion,'Prior completion committed and returned';
  assert (select request='{}'::jsonb and last_error is null and lease_token is null and lease_expires_at is null and completion_lease_token is null from public.hermes_inbound_turns where id=prior.id),'Only prior turn is cleaned up; no private token copied';
  assert (select status='running' and lease_token=owner.lease_token and response is null from public.hermes_inbound_turns where id=owner.id),'Current owner remains live and untouched';
  assert public.resolve_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id,expected,completion) is null,'Publication cannot replay';
  assert public.observe_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id,expected,completion)=result,'Lost publication reply observable without a write';
  assert public.observe_hermes_interrupted_active_completion(owner.id,gen_random_uuid(),u,owner.message_id,owner.thread_id,expected,completion) is null,'Observer requires active owner nonce';
  assert public.observe_hermes_interrupted_active_completion(owner.id,owner.lease_token,u,owner.message_id,owner.thread_id,expected,jsonb_set(completion,'{sourceFingerprint}','"changed"')) is null,'Observer matches exact certificate';
  assert not has_function_privilege('anon','public.resolve_hermes_interrupted_active_completion(uuid,uuid,uuid,text,text,jsonb,jsonb)','execute'),'Publication private';
  assert not has_function_privilege('authenticated','public.observe_hermes_interrupted_active_completion(uuid,uuid,uuid,text,text,jsonb,jsonb)','execute'),'Observation private';
end;
$$;
