-- Run after speaking_single_scenario_plans with ON_ERROR_STOP. Synthetic data rolls back.
begin;
set local role service_role;
do $$
declare
  owner_a text := 'plan-sql-a-' || gen_random_uuid()::text;
  owner_b text := 'plan-sql-b-' || gen_random_uuid()::text;
  item_id uuid := gen_random_uuid();
  plan_id uuid := gen_random_uuid();
  candidate_id uuid := gen_random_uuid();
  client_id uuid := gen_random_uuid();
  snapshots jsonb;
  target jsonb;
  candidate jsonb;
  plan jsonb;
  session_doc jsonb;
  replay jsonb;
  candidate_unknown jsonb;
  plan_unknown jsonb;
  comparison_plan jsonb;
  sized_candidates jsonb;
  candidate_count integer;
begin
  assert not has_table_privilege('anon', 'public.speaking_plans', 'select');
  assert not has_table_privilege('authenticated', 'public.speaking_plans', 'insert');
  assert not has_table_privilege('service_role', 'public.speaking_plans', 'update');
  assert not has_function_privilege('authenticated', 'public.save_speaking_plan(text,jsonb,jsonb)', 'execute');
  assert not has_function_privilege('anon', 'public.get_speaking_plan(text,uuid)', 'execute');
  assert not (select prosecdef from pg_proc where oid =
    'public.save_speaking_plan(text,jsonb,jsonb)'::regprocedure);
  assert not has_function_privilege('authenticated',
    'public.create_planned_speaking_loadout(text,uuid,text,text,text,text,jsonb,uuid[],uuid,uuid)', 'execute');
  assert not (select prosecdef from pg_proc where oid =
    'public.create_planned_speaking_loadout(text,uuid,text,text,text,text,jsonb,uuid[],uuid,uuid)'::regprocedure);
  insert into public.profiles(id) values (owner_a), (owner_b);
  insert into public.corpus_items(id,user_id,kind,text,meaning,usage_context,tags,source_locator)
    values (item_id,owner_a,'chunk','to be fair','Acknowledge a reasonable view',
      'Concede before giving your view',array['conceding'],
      '{"source_title":"Source","snapshot":{"register":"professional","scenario_tags":["workplace"]}}');
  select jsonb_build_array(public.speaking_corpus_snapshot(c)) into snapshots
    from public.corpus_items c where id = item_id;
  target := jsonb_build_object(
    'corpus_item_id',item_id,'role','primary','communicative_function','Acknowledge another perspective',
    'fit','high','fit_reason','Both colleagues have valid concerns.','metadata_status','available',
    'trigger_question','What is reasonable about their concern?','skip_when','There is no competing concern.');
  candidate := jsonb_build_object(
    'id',candidate_id,'title','Discuss the deadline','setting','A project is delayed.',
    'goal','Agree on a revised deadline','user_role','Project lead','ai_role','Delivery manager',
    'register','professional','targets',jsonb_build_array(target));
  plan := jsonb_build_object(
    'id',plan_id,'version',1,'scenario_type','workplace','brief','Discuss a deadline','created_at',now(),
    'candidates',jsonb_build_array(candidate));
  assert public.save_speaking_plan(owner_a,plan,snapshots) = plan;
  assert public.save_speaking_plan(owner_a,plan,snapshots) = plan;
  assert public.get_speaking_plan(owner_a,plan_id) = plan;
  assert public.get_speaking_plan(owner_b,plan_id) is null;
  -- Single-scene startup and legacy comparison plans use the same save contract.
  for candidate_count in 0..4 loop
    select coalesce(jsonb_agg(candidate || jsonb_build_object('id',gen_random_uuid(),
      'title','Compare scene ' || index)), '[]'::jsonb)
      into sized_candidates from generate_series(1,candidate_count) as candidates(index);
    comparison_plan := plan || jsonb_build_object('id',gen_random_uuid(),'candidates',sized_candidates);
    if candidate_count between 1 and 3 then
      assert public.save_speaking_plan(owner_a,comparison_plan,snapshots) = comparison_plan;
    else
      begin
        perform public.save_speaking_plan(owner_a,comparison_plan,snapshots);
        raise exception 'Expected invalid candidate count rejection';
      exception when sqlstate 'PT422' then null; end;
    end if;
  end loop;
  begin
    perform public.create_planned_speaking_loadout(owner_b,gen_random_uuid(),'workplace',
      'Agree on a revised deadline','standard','balanced',null,array[item_id],plan_id,candidate_id);
    raise exception 'Expected owner rejection';
  exception when sqlstate 'PT404' then null; end;
  begin
    perform public.create_planned_speaking_loadout(owner_a,gen_random_uuid(),'workplace',
      'Invented goal','standard','balanced',null,array[item_id],plan_id,candidate_id);
    raise exception 'Expected candidate mismatch';
  exception when sqlstate 'PT409' then null; end;

  update public.corpus_items set meaning = 'Changed after planning' where id = item_id;
  begin
    perform public.create_planned_speaking_loadout(owner_a,gen_random_uuid(),'workplace',
      'Agree on a revised deadline','standard','balanced',null,array[item_id],plan_id,candidate_id);
    raise exception 'Expected stale-plan rejection';
  exception when sqlstate 'PT412' then null; end;
  update public.corpus_items set meaning = 'Acknowledge a reasonable view' where id = item_id;

  candidate_unknown := jsonb_set(candidate,'{targets,0,fit}','"unknown"');
  plan_unknown := plan || jsonb_build_object('id',gen_random_uuid(),
    'candidates',jsonb_build_array(candidate_unknown));
  perform public.save_speaking_plan(owner_a,plan_unknown,snapshots);
  begin
    perform public.create_planned_speaking_loadout(owner_a,gen_random_uuid(),'workplace',
      'Agree on a revised deadline','standard','balanced',null,array[item_id],
      (plan_unknown->>'id')::uuid,candidate_id);
    raise exception 'Expected insufficient primary fit rejection';
  exception when sqlstate 'PT424' then null; end;

  session_doc := public.create_planned_speaking_loadout(owner_a,client_id,'workplace',
    'Agree on a revised deadline','standard','balanced',null,array[item_id],plan_id,candidate_id);
  assert session_doc #>> '{mission_plan,plan_id}' = plan_id::text;
  assert session_doc #>> '{mission_plan,targets,0,session_item_id}' = session_doc #>> '{items,0,id}';
  assert session_doc #>> '{items,0,register}' = 'professional';
  assert session_doc #> '{items,0,scenario_tags}' = '["workplace"]'::jsonb;
  assert session_doc #>> '{items,0,usage_note}' = 'Concede before giving your view';
  begin
    perform public.create_speaking_loadout(owner_a,client_id,'workplace',
      'Agree on a revised deadline','standard','balanced',null,array[item_id]);
    raise exception 'Legacy create must not reuse a planned submission';
  exception when sqlstate 'PT409' then null; end;
  delete from public.corpus_items where id = item_id;
  delete from public.speaking_plans where id = plan_id;
  replay := public.create_planned_speaking_loadout(owner_a,client_id,'workplace',
    'Agree on a revised deadline','standard','balanced',null,array[item_id],plan_id,candidate_id);
  assert replay->>'id' = session_doc->>'id';
  assert replay #> '{items,0,corpus_item_id}' = 'null'::jsonb;
  assert replay->'mission_plan' = session_doc->'mission_plan';
  assert replay #>> '{items,0,text}' = 'to be fair';
  assert public.get_speaking_loadout(owner_a,(session_doc->>'id')::uuid) = replay;
end;
$$;
rollback;
