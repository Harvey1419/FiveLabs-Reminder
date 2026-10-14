do $$
#variable_conflict use_variable
declare u uuid:=gen_random_uuid(); t text:='atomic-task-'||gen_random_uuid()::text; op text;
  run_id uuid; task_id uuid; reminder_id uuid; owner_row public.hermes_inbound_turns; recovery public.hermes_inbound_turns;
  expected jsonb; grant_receipt jsonb; call jsonb; receipt jsonb; source jsonb; rolled_back boolean;
begin
  insert into public.users(id) values(u);
  foreach op in array array['complete','delete'] loop
    insert into public.tasks(user_id,title) values(u,'Atomic '||op) returning id into task_id;
    insert into public.reminders(user_id,task_id,phone_number,content,send_at) values(u,task_id,'fixture','Linked',clock_timestamp()+interval '1 hour') returning id into reminder_id;
    insert into public.agent_runs(user_id,thread_id,status,kind,context,expires_at)
      values(u,t||op,'waiting_for_approval','generic_operation','{}',clock_timestamp()+interval '1 hour') returning id into run_id;
    call:=jsonb_build_object('toolName','manage_task','params',jsonb_build_object('action',op,'target',task_id::text));
    insert into public.prepared_actions(run_id,call_id,domain,action,target_id,payload) values(run_id,'a','task',op,task_id,call->'params');
    insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at)
      values(t||op,t||op,'{}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into owner_row;
    select public.agent_core_active_snapshot(run_id,to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) into expected from public.agent_runs where id=run_id;
    grant_receipt:=public.claim_hermes_active_run(owner_row.id,owner_row.lease_token,expected,'running','{"relation":"approval","decision":"approve_all"}');
    assert public.execute_hermes_atomic_task(owner_row.id,owner_row.lease_token,u,call) is null,'Missing durable fence denied';
    perform public.mutate_hermes_active_run(owner_row.id,owner_row.lease_token,run_id,(grant_receipt->>'claimId')::uuid,'action',
      jsonb_build_object('callId','a','expected',expected->'actions'->0,'updates',jsonb_build_object('status','failed',
        'executionFact',jsonb_build_object('success',false,'outcome','unknown','_domainCall',call))));
    assert public.execute_hermes_atomic_task(owner_row.id,gen_random_uuid(),u,call) is null,'Wrong lease denied';
    assert public.execute_hermes_atomic_task(owner_row.id,owner_row.lease_token,gen_random_uuid(),call) is null,'Foreign user denied';
    assert public.execute_hermes_atomic_task(owner_row.id,owner_row.lease_token,u,jsonb_set(call,'{params,target}',to_jsonb(gen_random_uuid()::text))) is null,'Changed target denied';
    update public.reminders set status='processing' where id=reminder_id;
    assert public.execute_hermes_atomic_task(owner_row.id,owner_row.lease_token,u,call) is null,'In-flight companion blocks mutation';
    update public.reminders set status='pending' where id=reminder_id;
    update public.tasks set title=repeat('x',2001) where id=task_id;
    assert public.execute_hermes_atomic_task(owner_row.id,owner_row.lease_token,u,call) is null,'Over-contract legacy row denied before effects';
    update public.tasks set title='Atomic '||op where id=task_id;
    execute $fn$create or replace function pg_temp.reject_atomic_receipt() returns trigger language plpgsql as
      'begin raise exception ''receipt failed'' using errcode=''23514''; end;'$fn$;
    create trigger reject_atomic_receipt before insert on public.hermes_atomic_task_receipts for each row execute function pg_temp.reject_atomic_receipt();
    rolled_back:=false;
    begin perform public.execute_hermes_atomic_task(owner_row.id,owner_row.lease_token,u,call);
    exception when check_violation then rolled_back:=true; end;
    assert rolled_back,'Receipt failure propagated';
    assert (select status='pending' from public.tasks where id=task_id),'Task rolled back with receipt failure';
    assert (select r.status='pending' and r.task_id is not null from public.reminders r where id=reminder_id),'Companion rolled back with receipt failure';
    drop trigger reject_atomic_receipt on public.hermes_atomic_task_receipts;
    receipt:=public.execute_hermes_atomic_task(owner_row.id,owner_row.lease_token,u,call);
    assert receipt->'item'->'result'->'complete'='true','Complete transactional receipt returned';
    assert receipt->'companionReminderIds'=jsonb_build_array(reminder_id::text),'Companion identity covered';
    assert public.execute_hermes_atomic_task(owner_row.id,owner_row.lease_token,u,call)=receipt,'Lost response retry returns same receipt';
    assert (select count(*)=1 from public.hermes_atomic_task_receipts r where r.run_id=run_id),'No duplicate receipt';
    if op='complete' then
      assert (select status='completed' from public.tasks where id=task_id),'Task completion committed';
      assert (select status='sent' and acknowledged_at is not null from public.reminders where id=reminder_id),'Completion companion committed';
    else
      assert not exists(select 1 from public.tasks where id=task_id),'Task deletion committed';
      assert (select r.status='cancelled' and r.task_id is null from public.reminders r where id=reminder_id),'Delete companion handled before FK detachment';
    end if;
    -- Simulate loss after commit: action still has its unknown fence and no inferred success fact.
    update public.hermes_inbound_turns set status='unknown' where id=owner_row.id;
    insert into public.hermes_inbound_turns(message_id,thread_id,request,status,lease_token,lease_expires_at)
      values(t||op||'-recover',t||op,'{}','running',gen_random_uuid(),clock_timestamp()+interval '120 seconds') returning * into recovery;
    source:=public.read_hermes_active_run_recovery(recovery.id,recovery.lease_token,u,recovery.message_id,recovery.thread_id);
    assert public.read_hermes_atomic_task_receipt(recovery.id,recovery.lease_token,source,'a')=receipt,'Independent receipt survives lost execution response';
    assert public.read_hermes_atomic_task_receipt(recovery.id,recovery.lease_token,source,'missing') is null,'Missing receipt never proves no effect';
    assert (select execution_fact->>'outcome'='unknown' from public.prepared_actions a where a.run_id=run_id),'Original unknown fence remains intact';
  end loop;
  assert not has_function_privilege('anon','public.execute_hermes_atomic_task(uuid,uuid,uuid,jsonb)','execute'),'Anonymous execution denied';
  assert not has_function_privilege('authenticated','public.read_hermes_atomic_task_receipt(uuid,uuid,jsonb,text)','execute'),'Frontend receipt read denied';
  assert not has_table_privilege('service_role','public.hermes_atomic_task_receipts','update'),'Receipts cannot be rewritten';
end;
$$;
