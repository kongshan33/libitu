-- Run only after the speaking_runtime_state migration. Leaves no fixture data.
begin;
set local role service_role;

do $$
declare
  v_owner text := 'runtime-sql-' || gen_random_uuid()::text;
  v_other text := 'runtime-sql-other-' || gen_random_uuid()::text;
  v_id uuid := gen_random_uuid();
  v_abandoned uuid := gen_random_uuid();
  v_result jsonb;
  v_doc jsonb;
  v_status text;
  v_role text;
begin
  assert (select relrowsecurity from pg_class where oid = 'public.speaking_runtime_state'::regclass);
  foreach v_role in array array['anon', 'authenticated'] loop
    assert not has_table_privilege(v_role, 'public.speaking_runtime_state', 'SELECT');
    assert not has_table_privilege(v_role, 'public.speaking_runtime_state', 'INSERT');
    assert not has_table_privilege(v_role, 'public.speaking_runtime_state', 'UPDATE');
    assert not has_table_privilege(v_role, 'public.speaking_runtime_state', 'DELETE');
    assert not has_function_privilege(v_role, 'public.read_speaking_runtime(text,uuid)', 'EXECUTE');
    assert not has_function_privilege(v_role, 'public.cas_speaking_runtime(text,uuid,bigint,jsonb,text,integer)', 'EXECUTE');
    assert not has_function_privilege(v_role, 'public.delete_speaking_runtime(text,uuid)', 'EXECUTE');
  end loop;
  assert not exists (
    select 1 from pg_proc where oid in (
      'public.read_speaking_runtime(text,uuid)'::regprocedure,
      'public.cas_speaking_runtime(text,uuid,bigint,jsonb,text,integer)'::regprocedure,
      'public.delete_speaking_runtime(text,uuid)'::regprocedure
    ) and prosecdef
  );

  insert into public.profiles(id) values (v_owner), (v_other);
  insert into public.speaking_sessions(id, user_id, client_id, request_payload, scenario_type, goal)
    values (v_id, v_owner, gen_random_uuid(), '{}'::jsonb, 'workplace', 'A runtime test'),
      (v_abandoned, v_owner, gen_random_uuid(), '{}'::jsonb, 'everyday', 'An abandoned test');
  insert into public.speaking_session_items(session_id, ordinal, kind, text_snapshot)
    values (v_id, 0, 'idiom', 'on the same page');

  assert public.read_speaking_runtime(v_owner, v_id) =
    '{"version":0,"document":{},"status":"draft","turn_count":0}'::jsonb;
  assert public.read_speaking_runtime(v_other, v_id) is null;
  assert public.read_speaking_runtime(v_owner, gen_random_uuid()) is null;
  assert public.cas_speaking_runtime(v_other, v_id, 0, '{}', 'active', 1) is null;
  assert not public.delete_speaking_runtime(v_other, v_id);

  v_doc := '{"messages":[{"text":"We are on the same page. 继续吧。"}],"policy":{"instruction":"private"}}'::jsonb;
  v_result := public.cas_speaking_runtime(v_owner, v_id, 0, v_doc, 'active', 1);
  assert v_result = jsonb_build_object('version', 1, 'document', v_doc, 'status', 'active', 'turn_count', 1);
  assert public.read_speaking_runtime(v_owner, v_id) = v_result;
  assert public.get_speaking_loadout(v_owner, v_id)->>'turn_count' = '1';
  assert public.get_speaking_loadout(v_owner, v_id)->>'status' = 'active';
  assert (select started_at is not null from public.speaking_sessions where id = v_id);
  assert not exists (select 1 from public.speaking_turns where session_id = v_id);

  begin
    perform public.cas_speaking_runtime(v_owner, v_id, 0, '{"lost":"write"}', 'active', 9);
    raise exception 'stale version unexpectedly succeeded';
  exception when sqlstate 'PT409' then null;
  end;
  assert public.read_speaking_runtime(v_owner, v_id) = v_result;

  begin
    perform public.cas_speaking_runtime(v_owner, v_id, 1, jsonb_build_object('text', repeat('界', 349526)), 'active', 2);
    raise exception 'oversized UTF-8 document unexpectedly succeeded';
  exception when sqlstate 'PT422' then null;
  end;
  begin
    perform public.cas_speaking_runtime(v_owner, v_id, 1, '[]', 'active', 2);
    raise exception 'array document unexpectedly succeeded';
  exception when sqlstate 'PT422' then null;
  end;
  begin
    perform public.cas_speaking_runtime(v_owner, v_id, -1, '{}', 'active', 2);
    raise exception 'negative version unexpectedly succeeded';
  exception when sqlstate 'PT422' then null;
  end;
  begin
    perform public.cas_speaking_runtime(v_owner, v_id, 1, '{}', 'active', -1);
    raise exception 'negative count unexpectedly succeeded';
  exception when sqlstate 'PT422' then null;
  end;
  assert public.read_speaking_runtime(v_owner, v_id) = v_result;

  perform public.cas_speaking_runtime(v_owner, v_id, 1, v_doc, 'completed', 1);
  foreach v_status in array array['draft', 'active', 'abandoned'] loop
    begin
      perform public.cas_speaking_runtime(v_owner, v_id, 2, '{}', v_status, 0);
      raise exception 'completed session changed terminal status';
    exception when sqlstate 'PT409' then null;
    end;
  end loop;
  v_result := public.cas_speaking_runtime(v_owner, v_id, 2, v_doc || '{"analysis_status":"ready"}', 'completed', 1);
  assert v_result->>'version' = '3';
  assert (select completed_at is not null from public.speaking_sessions where id = v_id);

  perform public.cas_speaking_runtime(v_owner, v_abandoned, 0, '{}', 'abandoned', 0);
  foreach v_status in array array['draft', 'active', 'completed'] loop
    begin
      perform public.cas_speaking_runtime(v_owner, v_abandoned, 1, '{}', v_status, 0);
      raise exception 'abandoned session changed terminal status';
    exception when sqlstate 'PT409' then null;
    end;
  end loop;
  assert public.cas_speaking_runtime(v_owner, v_abandoned, 1, '{"final":true}', 'abandoned', 0)->>'version' = '2';

  assert public.delete_speaking_runtime(v_owner, v_id);
  assert not exists (select 1 from public.speaking_runtime_state where session_id = v_id);
  assert not exists (select 1 from public.speaking_session_items where session_id = v_id);
  assert public.read_speaking_runtime(v_owner, v_id) is null;
  assert public.get_speaking_loadout(v_owner, v_id) is null;
  assert public.cas_speaking_runtime(v_owner, v_id, 3, v_doc, 'completed', 1) is null;
  assert not public.delete_speaking_runtime(v_owner, v_id);
end;
$$;

rollback;
