-- Run after the speaking-loadout migration with psql ON_ERROR_STOP=1.
-- All synthetic records are rolled back, including after successful assertions.
begin;
set local role service_role;

do $$
declare
  owner_a text := 'loadout-sql-a-' || gen_random_uuid()::text;
  owner_b text := 'loadout-sql-b-' || gen_random_uuid()::text;
  client_id uuid := gen_random_uuid();
  expression_ids uuid[] := array[]::uuid[];
  structure_ids uuid[] := array[]::uuid[];
  selected_ids uuid[];
  item_id uuid;
  other_id uuid := gen_random_uuid();
  session_doc jsonb;
  replay_doc jsonb;
  other_doc jsonb;
  session_id uuid;
  template jsonb := '{"id":"persuasive_pitch","title":"Persuasive pitch","description":"Make a case under pushback","steps":["Context","Tension","Proposal","Defend"]}'::jsonb;
  count_before integer;
  i integer;
begin
  assert not has_function_privilege('anon', 'public.create_speaking_loadout(text,uuid,text,text,text,text,jsonb,uuid[])', 'execute');
  assert not has_function_privilege('authenticated', 'public.create_speaking_loadout(text,uuid,text,text,text,text,jsonb,uuid[])', 'execute');
  assert not has_function_privilege('anon', 'public.get_speaking_loadout(text,uuid)', 'execute');
  assert not has_function_privilege('authenticated', 'public.get_speaking_loadout(text,uuid)', 'execute');
  assert has_function_privilege('service_role', 'public.create_speaking_loadout(text,uuid,text,text,text,text,jsonb,uuid[])', 'execute');
  assert has_function_privilege('service_role', 'public.get_speaking_loadout(text,uuid)', 'execute');
  assert not has_table_privilege('authenticated', 'public.speaking_sessions', 'insert');
  assert not has_table_privilege('authenticated', 'public.speaking_session_items', 'update');
  assert not (select prosecdef from pg_proc where oid = 'public.create_speaking_loadout(text,uuid,text,text,text,text,jsonb,uuid[])'::regprocedure);
  assert not (select prosecdef from pg_proc where oid = 'public.get_speaking_loadout(text,uuid)'::regprocedure);

  insert into public.profiles(id) values (owner_a), (owner_b);
  for i in 1..6 loop
    item_id := gen_random_uuid();
    insert into public.corpus_items(id, user_id, kind, text, meaning, tags, source_locator)
      values (item_id, owner_a, case when i = 1 then 'idiom' else 'chunk' end,
        'Expression ' || i::text, 'Original meaning', array['softening'], '{"source_title":"SQL source"}');
    expression_ids := array_append(expression_ids, item_id);
  end loop;
  for i in 1..4 loop
    item_id := gen_random_uuid();
    insert into public.corpus_items(id, user_id, kind, text, slots)
      values (item_id, owner_a, 'structure', 'The point is {point} ' || i::text, '{"point":"a view"}');
    structure_ids := array_append(structure_ids, item_id);
  end loop;
  insert into public.corpus_items(id, user_id, kind, text) values (other_id, owner_b, 'chunk', 'Another account');

  selected_ids := array[expression_ids[1], structure_ids[1], expression_ids[2], structure_ids[2],
    expression_ids[3], structure_ids[3], expression_ids[4], expression_ids[5]];
  session_doc := public.create_speaking_loadout(owner_a, client_id, 'workplace', '  Agree on a deadline  ',
    'challenging', 'detailed', template, selected_ids);
  session_id := (session_doc->>'id')::uuid;
  assert session_doc->>'user_id' = owner_a;
  assert session_doc->>'goal' = 'Agree on a deadline';
  assert session_doc->>'status' = 'draft' and (session_doc->>'turn_count')::integer = 0;
  assert session_doc->>'difficulty' = 'challenging' and session_doc->>'feedback_level' = 'detailed';
  assert session_doc->'logic_template' = template;
  assert jsonb_array_length(session_doc->'items') = 8;
  assert session_doc #>> '{items,0,kind}' = 'idiom';
  assert session_doc #>> '{items,0,corpus_item_id}' = expression_ids[1]::text;
  assert session_doc #>> '{items,1,corpus_item_id}' = structure_ids[1]::text;
  assert session_doc #>> '{items,7,ordinal}' = '7';
  assert session_doc #>> '{items,1,slots,point}' = 'a view';
  assert session_doc #>> '{items,0,source_title}' = 'SQL source';
  assert public.get_speaking_loadout(owner_a, session_id) = session_doc;
  assert public.get_speaking_loadout(owner_b, session_id) is null;
  assert public.get_speaking_loadout(owner_a, gen_random_uuid()) is null;

  replay_doc := public.create_speaking_loadout(owner_a, client_id, 'workplace', 'Agree on a deadline',
    'challenging', 'detailed', template, selected_ids);
  assert replay_doc = session_doc;
  select count(*) into count_before from public.speaking_sessions where user_id = owner_a;
  assert count_before = 1;

  begin
    perform public.create_speaking_loadout(owner_a, client_id, 'workplace', 'Different goal',
      'challenging', 'detailed', template, selected_ids);
    raise exception 'Expected changed-payload conflict';
  exception when sqlstate 'PT409' then null; end;
  begin
    perform public.create_speaking_loadout(owner_a, gen_random_uuid(), 'workplace', 'Goal',
      'standard', 'balanced', null, array[expression_ids[1], other_id]);
    raise exception 'Expected foreign-owner rejection';
  exception when sqlstate 'PT404' then null; end;
  begin
    perform public.create_speaking_loadout(owner_a, gen_random_uuid(), 'workplace', 'Goal',
      'standard', 'balanced', null, array[expression_ids[1], gen_random_uuid()]);
    raise exception 'Expected missing-item rejection';
  exception when sqlstate 'PT404' then null; end;
  begin
    perform public.create_speaking_loadout(owner_a, gen_random_uuid(), 'workplace', 'Goal',
      'standard', 'balanced', null, array[]::uuid[]);
    raise exception 'Expected empty-selection rejection';
  exception when sqlstate 'PT422' then null; end;
  begin
    perform public.create_speaking_loadout(owner_a, gen_random_uuid(), 'workplace', 'Goal',
      'standard', 'balanced', null, array[expression_ids[1], expression_ids[1]]);
    raise exception 'Expected duplicate-selection rejection';
  exception when sqlstate 'PT422' then null; end;
  begin
    perform public.create_speaking_loadout(owner_a, gen_random_uuid(), 'workplace', 'Goal',
      'standard', 'balanced', null, structure_ids);
    raise exception 'Expected structure-limit rejection';
  exception when sqlstate 'PT422' then null; end;
  begin
    perform public.create_speaking_loadout(owner_a, gen_random_uuid(), 'workplace', 'Goal',
      'standard', 'balanced', null, expression_ids);
    raise exception 'Expected shared expression-limit rejection';
  exception when sqlstate 'PT422' then null; end;
  assert (select count(*) from public.speaking_sessions where user_id = owner_a) = count_before;
  assert (select count(*) from public.speaking_session_items i where i.session_id = (session_doc->>'id')::uuid) = 8;

  update public.corpus_items set text = 'Edited after creation', tags = array['edited'], meaning = 'Edited'
    where id = expression_ids[1];
  assert public.get_speaking_loadout(owner_a, session_id) = session_doc;
  delete from public.corpus_items where id = expression_ids[1];
  replay_doc := public.create_speaking_loadout(owner_a, client_id, 'workplace', 'Agree on a deadline',
    'challenging', 'detailed', template, selected_ids);
  assert replay_doc->>'id' = session_id::text;
  assert replay_doc #> '{items,0,corpus_item_id}' = 'null'::jsonb;
  assert replay_doc #>> '{items,0,text}' = 'Expression 1';
  assert replay_doc #>> '{items,0,meaning}' = 'Original meaning';
  assert replay_doc #> '{items,0,tags}' = '["softening"]'::jsonb;
  assert public.get_speaking_loadout(owner_a, session_id) = replay_doc;

  -- Submission IDs are unique per owner, not globally.
  other_doc := public.create_speaking_loadout(owner_b, client_id, 'everyday', 'One item is enough',
    'guided', 'light', null, array[other_id]);
  assert other_doc->>'id' <> session_doc->>'id';
  assert other_doc->>'user_id' = owner_b;
  assert other_doc->'logic_template' = 'null'::jsonb;
  assert jsonb_array_length(other_doc->'items') = 1;
end;
$$;
rollback;
