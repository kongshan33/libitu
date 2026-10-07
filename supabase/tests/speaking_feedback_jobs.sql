-- Explicit integration verification. All synthetic rows are rolled back.
begin;
do $$
declare
  owner_id text := 'feedback-verification-' || gen_random_uuid()::text;
  other_id text := 'feedback-other-' || gen_random_uuid()::text;
  target_session_id uuid := gen_random_uuid();
  active_id uuid := gen_random_uuid();
  initial jsonb;
  claimed jsonb;
  reclaimed jsonb;
  done jsonb;
  attempt integer;
begin
  insert into public.profiles(id) values (owner_id),(other_id);
  insert into public.speaking_sessions(id,user_id,client_id,request_payload,scenario_type,goal,status)
    values (target_session_id,owner_id,gen_random_uuid(),'{}','workplace','Synthetic feedback verification','completed'),
           (active_id,owner_id,gen_random_uuid(),'{}','everyday','Synthetic active verification','active');
  insert into public.speaking_runtime_state(session_id,version,document) values
    (target_session_id,1,'{"runtime":{"ticket":"must-not-copy"},"messages":[{"id":"u1","role":"user","text":"One trade-off is cost.","revision":1,"private":"must-not-copy"}],"controller":{"instruction":"must-not-copy","exposures":[{"id":"hint","after_turn":0,"private":"must-not-copy"}]}}');
  assert public.enqueue_speaking_feedback(other_id,target_session_id) is null, 'foreign enqueue';
  assert public.read_speaking_feedback(other_id,target_session_id) is null, 'foreign read';
  assert public.enqueue_speaking_feedback(owner_id,gen_random_uuid()) is null, 'missing enqueue';
  begin
    perform public.enqueue_speaking_feedback(owner_id,active_id);
    raise exception 'active session accepted';
  exception when sqlstate 'PT409' then null; end;
  assert public.pending_speaking_feedback_sessions(100) @> jsonb_build_array(jsonb_build_object('session_id',target_session_id,'user_id',owner_id)), 'missing recovery candidate';
  initial := public.enqueue_speaking_feedback(owner_id,target_session_id);
  assert initial->>'status' = 'queued' and (initial->>'attempts')::int = 0, 'enqueue status';
  assert initial->'source'->'messages'->0->>'text' = 'One trade-off is cost.', 'source missing';
  assert position('must-not-copy' in (initial->'source')::text) = 0, 'private source leak';
  assert public.enqueue_speaking_feedback(owner_id,target_session_id,true) = initial, 'enqueue not idempotent';
  update public.speaking_runtime_state set document='{"messages":[{"text":"late revision"}]}' where speaking_runtime_state.session_id = target_session_id;
  assert public.enqueue_speaking_feedback(owner_id,target_session_id)->'source' = initial->'source', 'source mutated';
  assert not (public.pending_speaking_feedback_sessions(100) @> jsonb_build_array(jsonb_build_object('session_id',target_session_id,'user_id',owner_id))), 'already queued candidate';
  assert public.claim_speaking_feedback(gen_random_uuid()) is null, 'filtered claim took other row';
  claimed := public.claim_speaking_feedback((initial->>'id')::uuid);
  assert claimed->>'status' = 'processing' and (claimed->>'attempts')::int = 1, 'first claim';
  assert public.claim_speaking_feedback((initial->>'id')::uuid) is null, 'double claim';
  update public.speaking_feedback set lease_expires_at=clock_timestamp()-interval '1 second' where id=(initial->>'id')::uuid;
  assert not public.complete_speaking_feedback((claimed->>'id')::uuid,(claimed->>'lease_token')::uuid,'ready','{}'), 'expired lease wrote';
  reclaimed := public.claim_speaking_feedback((initial->>'id')::uuid);
  assert reclaimed->>'lease_token' <> claimed->>'lease_token' and (reclaimed->>'attempts')::int=2, 'reclaim identity';
  assert not public.complete_speaking_feedback((claimed->>'id')::uuid,(claimed->>'lease_token')::uuid,'ready','{}'), 'stale worker wrote';
  assert public.complete_speaking_feedback((reclaimed->>'id')::uuid,(reclaimed->>'lease_token')::uuid,'partial','{"observed":1}','model_unavailable'), 'current lease failed';
  done := public.enqueue_speaking_feedback(owner_id,target_session_id);
  assert done->>'status'='partial', 'retry was automatic';
  done := public.enqueue_speaking_feedback(owner_id,target_session_id,true);
  assert done->>'status'='queued' and done->'source'=initial->'source' and done->'result'='{"observed":1}'::jsonb, 'retry snapshot lost';
  claimed := public.claim_speaking_feedback((initial->>'id')::uuid);
  assert (claimed->>'attempts')::int=3, 'retry attempt';
  update public.speaking_feedback set lease_expires_at=clock_timestamp()-interval '1 second' where id=(initial->>'id')::uuid;
  assert public.claim_speaking_feedback((initial->>'id')::uuid) is null, 'fourth attempt';
  done := public.enqueue_speaking_feedback(owner_id,target_session_id,true);
  assert done->>'status'='failed' and done->>'error_code'='retry_limit_reached', 'retry cap';
  assert public.delete_speaking_runtime(owner_id,target_session_id), 'delete parent';
  assert public.read_speaking_feedback(owner_id,target_session_id) is null, 'report survived delete';
  assert not public.complete_speaking_feedback((claimed->>'id')::uuid,(claimed->>'lease_token')::uuid,'ready','{}'), 'deleted worker resurrected';
  assert not exists(select 1 from public.speaking_feedback where id=(initial->>'id')::uuid), 'cascade missing';
  assert not has_function_privilege('authenticated','public.enqueue_speaking_feedback(text,uuid,boolean)','execute'), 'authenticated RPC exposed';
  assert not has_function_privilege('anon','public.claim_speaking_feedback(uuid)','execute'), 'anon worker RPC exposed';
  assert not has_table_privilege('authenticated','public.speaking_feedback','select'), 'snapshot table exposed';
  assert has_function_privilege('service_role','public.complete_speaking_feedback(uuid,uuid,text,jsonb,text)','execute'), 'server completion unavailable';
end;
$$;
rollback;
