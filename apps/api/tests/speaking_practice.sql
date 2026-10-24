-- Linked practice, legacy recovery, owner boundaries and frozen evidence; no retained fixtures.
begin;
set local role service_role;
do $$
declare
  owner_id text := 'practice-sql-' || gen_random_uuid()::text;
  ids uuid[] := array[gen_random_uuid(),gen_random_uuid()];
  old_client uuid := gen_random_uuid();
  parent_client uuid := gen_random_uuid();
  child_client uuid := gen_random_uuid();
  original_plan_id uuid := gen_random_uuid();
  practice_plan_id uuid := gen_random_uuid();
  candidate_id uuid := gen_random_uuid();
  practice_candidate_id uuid := gen_random_uuid();
  candidate jsonb;
  plan jsonb;
  snapshots jsonb;
  original jsonb;
  parent jsonb;
  child jsonb;
  changed jsonb;
  job jsonb;
begin
  assert not has_function_privilege('anon',
    'public.create_evidence_speaking_loadout(text,uuid,text,text,text,text,jsonb,uuid[],text,text,uuid,uuid)','execute');
  assert not has_function_privilege('authenticated','public.save_practice_speaking_plan(text,jsonb,jsonb)','execute');
  assert not (select prosecdef from pg_proc where oid =
    'public.create_evidence_speaking_loadout(text,uuid,text,text,text,text,jsonb,uuid[],text,text,uuid,uuid)'::regprocedure);
  insert into public.profiles(id) values(owner_id);
  insert into public.corpus_items(id,user_id,kind,text,tags,source_locator)
    values(ids[1],owner_id,'chunk','to be fair',array['old'],'{}'),
          (ids[2],owner_id,'chunk','in the long run',array['old'],'{}');
  original := public.create_supported_speaking_loadout(owner_id,old_client,'workplace',
    'Discuss priorities','standard','balanced',null,ids,'model_frame');
  assert original->'evidence_contract_version' = 'null'::jsonb;
  assert original #> '{items,0,source_corpus_item_id}' = 'null'::jsonb;
  -- The new code must recover an old supported submission without retroactive stamping.
  assert public.create_evidence_speaking_loadout(owner_id,old_client,'workplace',
    'Discuss priorities','standard','balanced',null,ids,'model_frame','speaking-evidence-v3') = original;
  select jsonb_agg(public.speaking_corpus_snapshot(c) order by r.ord) into snapshots
    from unnest(ids) with ordinality r(id,ord) join public.corpus_items c on c.id=r.id;
  candidate := jsonb_build_object(
    'id',candidate_id,'title','Project deadline','setting','Two colleagues discuss a delivery date.',
    'goal','Agree on next steps','user_role','Project lead','ai_role','Delivery manager',
    'register','professional','changes','[]'::jsonb,
    'targets',jsonb_build_array(
      jsonb_build_object('corpus_item_id',ids[1],'role','primary','fit','high','fit_reason','Competing priorities.',
        'communicative_function','Acknowledge another view','trigger_question','Which concern seems reasonable?',
        'skip_when','No competing concern remains.','sentence_frame','To be fair, [your point].'),
      jsonb_build_object('corpus_item_id',ids[2],'role','opportunity','fit','high','fit_reason','Consider lasting effects.',
        'communicative_function','Consider lasting effects','trigger_question','What happens after the first month?',
        'skip_when','Only immediate details matter.','sentence_frame','In the long run, [your point].')));
  plan := jsonb_build_object('id',original_plan_id,'version',1,'scenario_type','workplace','brief','',
    'created_at',now(),'candidates',jsonb_build_array(candidate,candidate || jsonb_build_object(
      'id',gen_random_uuid(),'title','Project scope')));
  perform public.save_speaking_plan(owner_id,plan,snapshots);
  parent := public.create_evidence_speaking_loadout(owner_id,parent_client,'workplace',
    'Agree on next steps','standard','balanced',null,ids,'model_frame','speaking-evidence-v3',
    original_plan_id,candidate_id);
  assert parent->>'evidence_contract_version'='speaking-evidence-v3';
  assert parent #>> '{items,0,source_corpus_item_id}'=ids[1]::text;
  assert parent #>> '{items,1,source_corpus_item_id}'=ids[2]::text;
  assert not (select request_payload ? 'evidence_contract_version' from public.speaking_sessions
    where id=(parent->>'id')::uuid);
  update public.speaking_sessions set status='completed' where id=(parent->>'id')::uuid;
  -- Tags can change between the parent and a new practice plan.
  update public.corpus_items set tags=array['updated'] where id=any(ids);
  select jsonb_agg(public.speaking_corpus_snapshot(c) order by r.ord) into snapshots
    from unnest(ids) with ordinality r(id,ord) join public.corpus_items c on c.id=r.id;
  candidate := candidate || jsonb_build_object('id',practice_candidate_id,'title','Budget review',
    'setting','The same colleagues discuss a revised budget.',
    'goal','Agree on the revised budget',
    'changes',jsonb_build_array(
      jsonb_build_object('field','setting','before','Two colleagues discuss a delivery date.',
        'after','The same colleagues discuss a revised budget.'),
      jsonb_build_object('field','goal','before','Agree on next steps','after','Agree on the revised budget')));
  plan := jsonb_build_object('id',practice_plan_id,'version',1,'scenario_type','workplace','brief','',
    'created_at',now(),'practice_source',jsonb_build_object(
      'parent_session_id',parent->'id','root_session_id',parent->'id',
      'variation','details','parent_snapshot_hash',repeat('a',64)),
    'candidates',jsonb_build_array(candidate,candidate || jsonb_build_object(
      'id',gen_random_uuid(),'title','Budget options')));
  begin
    perform public.save_practice_speaking_plan(owner_id||'-other',plan,snapshots);
    raise exception 'Expected foreign parent rejection';
  exception when sqlstate 'PT425' then null; end;
  begin
    perform public.save_practice_speaking_plan(owner_id,
      jsonb_set(plan,'{candidates,0,changes,0,before}','"Fabricated original"'),snapshots);
    raise exception 'Expected false change description rejection';
  exception when sqlstate 'PT425' then null; end;
  begin
    perform public.save_practice_speaking_plan(owner_id,
      jsonb_set(plan,'{candidates,0,targets,0,role}','"opportunity"'),snapshots);
    raise exception 'Expected changed target role rejection';
  exception when sqlstate 'PT425' then null; end;
  begin
    perform public.save_practice_speaking_plan(owner_id,plan,
      jsonb_set(snapshots,'{0,text}','"Changed language"'));
    raise exception 'Expected changed parent language rejection';
  exception when sqlstate 'PT425' then null; end;
  perform public.save_practice_speaking_plan(owner_id,plan,snapshots);
  changed := jsonb_set(plan,'{practice_source,variation}','"role_swap"');
  changed := jsonb_set(changed,'{candidates}',(
    select jsonb_agg(value || jsonb_build_object(
      'user_role','Delivery manager','ai_role','Project lead',
      'changes',value->'changes' || jsonb_build_array(
        jsonb_build_object('field','user_role','before','Project lead','after','Delivery manager'),
        jsonb_build_object('field','ai_role','before','Delivery manager','after','Project lead'))))
      from jsonb_array_elements(changed->'candidates')));
  assert public.validate_speaking_practice(owner_id,changed,snapshots)=(parent->>'id')::uuid;
  begin
    perform public.validate_speaking_practice(owner_id,
      jsonb_set(changed,'{candidates,0,user_role}','"Project lead"'),snapshots);
    raise exception 'Expected incorrect role swap rejection';
  exception when sqlstate 'PT425' then null; end;
  begin
    perform public.create_evidence_speaking_loadout(owner_id,child_client,'workplace',
      'Agree on the revised budget','standard','balanced',null,ids,null,null,
      practice_plan_id,practice_candidate_id);
    raise exception 'Expected explicit support requirement';
  exception when sqlstate 'PT426' then null; end;
  assert not exists(select 1 from public.speaking_sessions where user_id=owner_id and client_id=child_client);
  child := public.create_evidence_speaking_loadout(owner_id,child_client,'workplace',
    'Agree on the revised budget','standard','balanced',null,ids,'label_only','speaking-evidence-v3',
    practice_plan_id,practice_candidate_id);
  assert child #>> '{practice,parent_session_id}'=parent->>'id';
  assert child #>> '{practice,root_session_id}'=parent->>'id';
  assert child #>> '{practice,variation}'='details';
  assert child #> '{practice,changes}'=candidate->'changes';
  assert child #>> '{mission_plan,targets,0,parent_session_item_id}'=parent #>> '{items,0,id}';
  assert child #>> '{mission_plan,targets,1,parent_session_item_id}'=parent #>> '{items,1,id}';
  assert child #>> '{mission_plan,targets,0,session_item_id}'=child #>> '{items,0,id}';
  assert child #>> '{items,0,id}'<>parent #>> '{items,0,id}';
  assert child #>> '{items,0,tags,0}'='updated';
  assert public.get_speaking_loadout(owner_id||'-other',(child->>'id')::uuid) is null;
  begin
    perform public.create_evidence_speaking_loadout(owner_id,child_client,'workplace',
      'Agree on the revised budget','standard','balanced',null,ids,'no_hint','speaking-evidence-v3',
      practice_plan_id,practice_candidate_id);
    raise exception 'Expected changed support idempotency conflict';
  exception when sqlstate 'PT409' then null; end;
  update public.speaking_sessions set status='completed' where id=(child->>'id')::uuid;
  job := public.enqueue_speaking_feedback(owner_id,(child->>'id')::uuid,false);
  assert job->>'analysis_version'='speaking-feedback-v3';
  assert job #>> '{source,session,evidence_contract_version}'='speaking-evidence-v3';
  assert job #>> '{source,session,items,0,source_corpus_item_id}'=ids[1]::text;
  assert job #>> '{source,session,practice,parent_session_id}'=parent->>'id';
  delete from public.speaking_sessions where id=(parent->>'id')::uuid;
  delete from public.corpus_items where id=any(ids);
  delete from public.speaking_plans where id in(original_plan_id,practice_plan_id);
  changed := public.create_evidence_speaking_loadout(owner_id,child_client,'workplace',
    'Agree on the revised budget','standard','balanced',null,ids,'label_only','speaking-evidence-v3',
    practice_plan_id,practice_candidate_id);
  assert changed->>'id'=child->>'id';
  assert changed #> '{practice,parent_session_id}'='null'::jsonb;
  assert changed #> '{items,0,corpus_item_id}'='null'::jsonb;
  assert changed #>> '{items,0,source_corpus_item_id}'=ids[1]::text;
  assert changed->'mission_plan'=child->'mission_plan';
  assert public.read_speaking_feedback(owner_id,(child->>'id')::uuid)->'source'=job->'source';
end;
$$;
rollback;
