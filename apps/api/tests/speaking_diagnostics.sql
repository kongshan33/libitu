-- Run after speaking_teaching_diagnostics; all fixture data is rolled back.
begin;
set local role service_role;

do $$
declare
  v_owner text := 'diagnostic-sql-' || gen_random_uuid()::text;
  v_other text := 'diagnostic-other-' || gen_random_uuid()::text;
  v_session uuid := gen_random_uuid();
  v_id uuid := gen_random_uuid();
  v_second uuid := gen_random_uuid();
  v_event jsonb;
  v_page jsonb;
  v_before jsonb;
  v_role text;
begin
  assert (select relrowsecurity from pg_class where oid = 'public.speaking_diagnostic_events'::regclass);
  foreach v_role in array array['anon', 'authenticated'] loop
    assert not has_table_privilege(v_role, 'public.speaking_diagnostic_events', 'SELECT');
    assert not has_table_privilege(v_role, 'public.speaking_diagnostic_events', 'INSERT');
    assert not has_table_privilege(v_role, 'public.speaking_diagnostic_events', 'UPDATE');
    assert not has_table_privilege(v_role, 'public.speaking_diagnostic_events', 'DELETE');
    assert not has_function_privilege(v_role, 'public.append_speaking_diagnostic(text,uuid,jsonb)', 'EXECUTE');
    assert not has_function_privilege(v_role, 'public.read_speaking_diagnostics(text,uuid,integer,uuid)', 'EXECUTE');
    assert not has_function_privilege(v_role, 'public.purge_expired_speaking_diagnostics()', 'EXECUTE');
  end loop;
  assert not has_table_privilege('service_role', 'public.speaking_diagnostic_events', 'UPDATE');
  assert not exists (
    select 1 from pg_proc where oid in (
      'public.append_speaking_diagnostic(text,uuid,jsonb)'::regprocedure,
      'public.read_speaking_diagnostics(text,uuid,integer,uuid)'::regprocedure,
      'public.purge_expired_speaking_diagnostics()'::regprocedure
    ) and prosecdef
  );
  insert into public.profiles(id) values (v_owner), (v_other);
  insert into public.speaking_sessions(id, user_id, client_id, request_payload, scenario_type, goal)
    values(v_session, v_owner, gen_random_uuid(), '{}', 'workplace', 'A diagnostic fixture');
  perform public.cas_speaking_runtime(v_owner, v_session, 0, '{"messages":[]}', 'completed', 2);
  v_before := public.read_speaking_runtime(v_owner, v_session);
  v_event := jsonb_build_object('id', v_id, 'kind', 'analysis.finished',
    'created_at', '2026-10-18T10:00:00+00:00', 'payload', '{"raw_response":"private model output"}'::jsonb);

  assert public.append_speaking_diagnostic(v_other, v_session, v_event) is null;
  assert public.read_speaking_diagnostics(v_other, v_session) is null;
  assert public.append_speaking_diagnostic(v_owner, v_session, v_event);
  assert not public.append_speaking_diagnostic(v_owner, v_session, v_event || '{"payload":{"changed":true}}');
  assert public.read_speaking_diagnostics(v_owner, v_session)->'events'->0->'payload' = v_event->'payload';
  assert public.read_speaking_runtime(v_owner, v_session) = v_before;

  assert public.append_speaking_diagnostic(v_owner, v_session, v_event || jsonb_build_object(
    'id', v_second, 'kind', 'hint.displayed', 'created_at', '2026-10-18T10:00:01+00:00'));
  v_page := public.read_speaking_diagnostics(v_owner, v_session, 1);
  assert v_page->>'next_before' = v_second::text;
  assert v_page->'events'->0->>'id' = v_second::text;
  v_page := public.read_speaking_diagnostics(v_owner, v_session, 1, v_second);
  assert v_page->>'next_before' is null;
  assert v_page->'events'->0->>'id' = v_id::text;

  -- Expiration is based on storage receipt time; old source messages can still be diagnosed.
  insert into public.speaking_diagnostic_events(session_id, id, kind, created_at, payload, expires_at)
    values(v_session, gen_random_uuid(), 'analysis.expired', now(), '{}', now() - interval '1 second');
  assert jsonb_array_length(public.read_speaking_diagnostics(v_owner, v_session)->'events') = 2;
  assert exists (select 1 from public.speaking_diagnostic_events
    where session_id = v_session and expires_at <= now());
  -- Exercise purge_expired_speaking_diagnostics() only in an isolated database:
  -- it intentionally prunes every session and would lock existing rows even with rollback.
  begin
    update public.speaking_diagnostic_events set payload = '{}' where session_id = v_session;
    raise exception 'diagnostic rewrite unexpectedly allowed';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.append_speaking_diagnostic(v_owner, v_session,
      v_event || jsonb_build_object('id', gen_random_uuid(), 'payload', jsonb_build_object('raw', repeat('界', 50000))));
    raise exception 'oversized diagnostic payload accepted';
  exception when sqlstate 'PT422' then null;
  end;
  begin
    perform public.append_speaking_diagnostic(v_owner, v_session, v_event || '{"payload":[]}');
    raise exception 'array diagnostic payload accepted';
  exception when sqlstate 'PT422' then null;
  end;
  begin
    perform public.read_speaking_diagnostics(v_owner, v_session, 201);
    raise exception 'oversized diagnostic page accepted';
  exception when sqlstate 'PT422' then null;
  end;
  begin
    perform public.read_speaking_diagnostics(v_owner, v_session, 1, gen_random_uuid());
    raise exception 'unknown diagnostic cursor accepted';
  exception when sqlstate 'PT422' then null;
  end;
  assert public.delete_speaking_runtime(v_owner, v_session);
  assert not exists (select 1 from public.speaking_diagnostic_events where session_id = v_session);
  assert public.append_speaking_diagnostic(v_owner, v_session, v_event) is null;
  assert public.read_speaking_diagnostics(v_owner, v_session) is null;
end;
$$;

rollback;
