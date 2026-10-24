-- Run after speaking_support_and_demonstrations. Synthetic data rolls back.
begin;
set local role service_role;
do $$
declare
  owner_id text := 'support-sql-' || gen_random_uuid()::text;
  item_id uuid := gen_random_uuid();
  legacy_client uuid := gen_random_uuid();
  supported_client uuid := gen_random_uuid();
  planned_client uuid := gen_random_uuid();
  plan_id uuid := gen_random_uuid();
  candidate_id uuid := gen_random_uuid();
  legacy jsonb;
  supported jsonb;
  planned jsonb;
  snapshots jsonb;
  candidate jsonb;
  plan jsonb;
  runtime_doc jsonb;
  job jsonb;
begin
  assert not has_function_privilege('anon',
    'public.create_supported_speaking_loadout(text,uuid,text,text,text,text,jsonb,uuid[],text,uuid,uuid)','execute');
  assert not has_function_privilege('authenticated',
    'public.create_supported_speaking_loadout(text,uuid,text,text,text,text,jsonb,uuid[],text,uuid,uuid)','execute');
  assert not (select prosecdef from pg_proc where oid =
    'public.create_supported_speaking_loadout(text,uuid,text,text,text,text,jsonb,uuid[],text,uuid,uuid)'::regprocedure);
  insert into public.profiles(id) values (owner_id);
  insert into public.corpus_items(id,user_id,kind,text,tags,source_locator)
    values (item_id,owner_id,'chunk','to be fair',array['conceding'],'{}');
  legacy := public.create_speaking_loadout(owner_id,legacy_client,'workplace',
    'Agree on next steps','standard','balanced',null,array[item_id]);
  assert legacy->'support_level' = 'null'::jsonb;
  assert not (select request_payload ? 'support_level' from public.speaking_sessions
    where id=(legacy->>'id')::uuid);
  assert public.create_speaking_loadout(owner_id,legacy_client,'workplace',
    'Agree on next steps','standard','balanced',null,array[item_id]) = legacy;

  supported := public.create_supported_speaking_loadout(owner_id,supported_client,'workplace',
    'Agree on next steps','standard','balanced',null,array[item_id],'model_frame');
  assert supported->>'support_level' = 'model_frame';
  assert (select request_payload->>'support_level' from public.speaking_sessions
    where id=(supported->>'id')::uuid) = 'model_frame';
  assert public.create_supported_speaking_loadout(owner_id,supported_client,'workplace',
    'Agree on next steps','standard','balanced',null,array[item_id],'model_frame') = supported;
  assert public.get_speaking_loadout(owner_id || '-other',(supported->>'id')::uuid) is null;
  begin
    perform public.create_supported_speaking_loadout(owner_id,supported_client,'workplace',
      'Agree on next steps','standard','balanced',null,array[item_id],'no_hint');
    raise exception 'Expected changed support conflict';
  exception when sqlstate 'PT409' then null; end;
  begin
    perform public.create_supported_speaking_loadout(owner_id,legacy_client,'workplace',
      'Agree on next steps','standard','balanced',null,array[item_id],'model_frame');
    raise exception 'Expected old submission conflict';
  exception when sqlstate 'PT409' then null; end;
  begin
    perform public.create_speaking_loadout(owner_id,supported_client,'workplace',
      'Agree on next steps','standard','balanced',null,array[item_id]);
    raise exception 'Expected supported submission conflict';
  exception when sqlstate 'PT409' then null; end;
  begin
    perform public.create_supported_speaking_loadout(owner_id,gen_random_uuid(),'workplace',
      'Agree on next steps','standard','balanced',null,array[item_id],null);
    raise exception 'Expected invalid support rejection';
  exception when sqlstate 'PT422' then null; end;
  begin
    perform public.create_supported_speaking_loadout(owner_id,gen_random_uuid(),'workplace',
      'Agree on next steps','standard','balanced',null,array[item_id],'invented');
    raise exception 'Expected invalid enum rejection';
  exception when sqlstate 'PT422' then null; end;

  select jsonb_build_array(public.speaking_corpus_snapshot(c)) into snapshots
    from public.corpus_items c where id=item_id;
  candidate := jsonb_build_object(
    'id',candidate_id,'title','Agree on a deadline','setting','Two colleagues discuss delivery.',
    'goal','Agree on next steps','user_role','Project lead','ai_role','Delivery manager',
    'register','professional','targets',jsonb_build_array(jsonb_build_object(
      'corpus_item_id',item_id,'role','primary','fit','high','fit_reason','There are competing priorities.',
      'communicative_function','Acknowledge another perspective',
      'trigger_question','What seems reasonable about their concern?',
      'skip_when','No competing concern remains.','sentence_frame','To be fair, [your point].')));
  plan := jsonb_build_object('id',plan_id,'version',1,'scenario_type','workplace','brief','',
    'created_at',now(),'candidates',jsonb_build_array(candidate,candidate || jsonb_build_object(
      'id',gen_random_uuid(),'title','Agree on scope')));
  perform public.save_speaking_plan(owner_id,plan,snapshots);
  planned := public.create_supported_speaking_loadout(owner_id,planned_client,'workplace',
    'Agree on next steps','standard','balanced',null,array[item_id],'model_label',plan_id,candidate_id);
  assert planned->>'support_level' = 'model_label';
  assert planned #>> '{mission_plan,targets,0,sentence_frame}' = 'To be fair, [your point].';
  assert planned #>> '{mission_plan,targets,0,session_item_id}' = planned #>> '{items,0,id}';
  assert public.create_supported_speaking_loadout(owner_id,planned_client,'workplace',
    'Agree on next steps','standard','balanced',null,array[item_id],'model_label',plan_id,candidate_id) = planned;
  runtime_doc := jsonb_build_object(
    'support',jsonb_build_object('level','no_hint','version',1,'private','PRIVATE_SUPPORT'),
    'support_history',jsonb_build_array(jsonb_build_object(
      'level','no_hint','version',1,'at','2026-10-20T01:00:00Z','private','PRIVATE_HISTORY')),
    'controller',jsonb_build_object('exposures',jsonb_build_array(jsonb_build_object(
      'id','partial-audio','target_item_id',planned #>> '{items,0,id}','level','example',
      'certainty','possible','scope','session','private','PRIVATE_EXPOSURE'))),
    'teaching_attempts',jsonb_build_array(jsonb_build_object(
      'id','attempt','presented',true,'response_id','reply',
      'policy',jsonb_build_object('target_item_id',planned #>> '{items,0,id}',
        'action','model_then_transfer','support_level','model_label','support_version',0,
        'instruction','PRIVATE_INSTRUCTION'),
      'assessment',jsonb_build_object('outcome','reflected',
        'model_quote','To be fair, our budget is limited.',
        'transfer_question_quote','What is reasonable about their timing concern?',
        'private','PRIVATE_ASSESSMENT'))));
  insert into public.speaking_runtime_state(session_id,document,version)
    values ((planned->>'id')::uuid,runtime_doc,1);
  update public.speaking_sessions set status='completed' where id=(planned->>'id')::uuid;
  job := public.enqueue_speaking_feedback(owner_id,(planned->>'id')::uuid,false);
  assert job #>> '{source,session,support_level}' = 'model_label';
  assert job #>> '{source,support,level}' = 'no_hint';
  assert job #>> '{source,support_history,0,version}' = '1';
  assert job #>> '{source,controller,exposures,0,certainty}' = 'possible';
  assert job #>> '{source,teaching_attempts,0,policy,support_version}' = '0';
  assert job #>> '{source,teaching_attempts,0,assessment,model_quote}' = 'To be fair, our budget is limited.';
  assert job #>> '{source,teaching_attempts,0,assessment,transfer_question_quote}' =
    'What is reasonable about their timing concern?';
  assert (job->'source')::text not like '%PRIVATE_%';
  update public.speaking_runtime_state set document='{}' where session_id=(planned->>'id')::uuid;
  assert public.enqueue_speaking_feedback(owner_id,(planned->>'id')::uuid,true)->'source' = job->'source';

  delete from public.corpus_items where id=item_id;
  delete from public.speaking_plans where id=plan_id;
  assert public.create_supported_speaking_loadout(owner_id,supported_client,'workplace',
    'Agree on next steps','standard','balanced',null,array[item_id],'model_frame')->>'id' = supported->>'id';
  assert public.create_supported_speaking_loadout(owner_id,planned_client,'workplace',
    'Agree on next steps','standard','balanced',null,array[item_id],'model_label',plan_id,candidate_id)
    ->'mission_plan' = planned->'mission_plan';
  assert (select count(*) from public.speaking_sessions where user_id=owner_id) = 3;
end;
$$;
rollback;
