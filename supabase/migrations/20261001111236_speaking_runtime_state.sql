-- Finalized text/evidence and runtime leases share one compare-and-swap version.
-- FastAPI verifies Clerk ownership; no browser role can read these private documents.
alter table public.speaking_sessions
  add column turn_count integer not null default 0,
  add constraint speaking_sessions_turn_count_valid check (turn_count >= 0);

update public.speaking_sessions s set turn_count = (
  select count(*) from public.speaking_turns t where t.session_id = s.id and t.role = 'user'
);

create table public.speaking_runtime_state (
  session_id uuid primary key references public.speaking_sessions(id) on delete cascade,
  version bigint not null,
  document jsonb not null,
  updated_at timestamptz not null default now(),
  constraint speaking_runtime_version_valid check (version between 1 and 9007199254740991),
  constraint speaking_runtime_document_object check (jsonb_typeof(document) = 'object'),
  constraint speaking_runtime_document_size check (octet_length(document::text) <= 1048576)
);

alter table public.speaking_runtime_state enable row level security;
revoke all on public.speaking_runtime_state from public, anon, authenticated;
grant select, insert, update, delete on public.speaking_runtime_state to service_role;
create policy speaking_runtime_server_only on public.speaking_runtime_state
  for all to service_role using (true) with check (true);

create function public.read_speaking_runtime(p_user_id text, p_session_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'version', coalesce(r.version, 0), 'document', coalesce(r.document, '{}'::jsonb),
    'status', s.status, 'turn_count', s.turn_count
  )
  from public.speaking_sessions s
  left join public.speaking_runtime_state r on r.session_id = s.id
  where s.id = p_session_id and s.user_id = p_user_id and s.client_id is not null;
$$;

create function public.cas_speaking_runtime(
  p_user_id text, p_session_id uuid, p_expected_version bigint,
  p_document jsonb, p_status text, p_turn_count integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_session public.speaking_sessions%rowtype;
  v_version bigint;
begin
  if p_user_id is null or length(btrim(p_user_id)) = 0 or p_session_id is null
    or p_expected_version is null or p_expected_version not between 0 and 9007199254740990
    or p_document is null or jsonb_typeof(p_document) <> 'object'
    or octet_length(p_document::text) > 1048576
    or p_status is null or p_status not in ('draft', 'active', 'completed', 'abandoned')
    or p_turn_count is null or p_turn_count < 0
  then
    raise sqlstate 'PT422' using message = 'Invalid speaking runtime state.';
  end if;

  -- All mutations lock the parent first, including DELETE. No provider work runs here.
  select * into v_session from public.speaking_sessions
    where id = p_session_id and user_id = p_user_id and client_id is not null for update;
  if not found then
    return null;
  end if;
  select version into v_version from public.speaking_runtime_state where session_id = p_session_id;
  v_version := coalesce(v_version, 0);
  if v_version <> p_expected_version
    or (v_session.status in ('completed', 'abandoned') and p_status <> v_session.status)
  then
    raise sqlstate 'PT409' using message = 'Speaking runtime changed. Please retry.';
  end if;

  insert into public.speaking_runtime_state(session_id, version, document)
    values (p_session_id, v_version + 1, p_document)
    on conflict (session_id) do update set
      version = excluded.version, document = excluded.document, updated_at = now();
  update public.speaking_sessions set
    status = p_status, turn_count = p_turn_count,
    started_at = case when p_status = 'active' then coalesce(started_at, now()) else started_at end,
    completed_at = case when p_status = 'completed' then coalesce(completed_at, now()) else completed_at end
    where id = p_session_id;
  return jsonb_build_object(
    'version', v_version + 1, 'document', p_document, 'status', p_status, 'turn_count', p_turn_count
  );
end;
$$;

create function public.delete_speaking_runtime(p_user_id text, p_session_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.speaking_sessions
    where id = p_session_id and user_id = p_user_id and client_id is not null;
  return found;
end;
$$;

-- Stage 4 owns the durable count; runtime transcripts do not use legacy speaking_turns.
create or replace function public.get_speaking_loadout(p_user_id text, p_session_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id, 'user_id', s.user_id, 'client_id', s.client_id,
    'scenario_type', s.scenario_type, 'goal', s.goal, 'difficulty', s.difficulty,
    'feedback_level', s.feedback_level, 'logic_template', s.logic_template,
    'status', s.status, 'created_at', s.created_at, 'turn_count', s.turn_count,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'corpus_item_id', i.corpus_item_id, 'ordinal', i.ordinal,
        'kind', i.kind, 'text', i.text_snapshot, 'meaning', i.meaning_snapshot,
        'tags', i.tags_snapshot, 'slots', i.slots_snapshot, 'source_title', i.source_title_snapshot
      ) order by i.ordinal)
      from public.speaking_session_items i where i.session_id = s.id
    ), '[]'::jsonb)
  )
  from public.speaking_sessions s
  where s.id = p_session_id and s.user_id = p_user_id and s.client_id is not null;
$$;

revoke all on function public.read_speaking_runtime(text, uuid) from public, anon, authenticated;
revoke all on function public.cas_speaking_runtime(text, uuid, bigint, jsonb, text, integer)
  from public, anon, authenticated;
revoke all on function public.delete_speaking_runtime(text, uuid) from public, anon, authenticated;
revoke all on function public.get_speaking_loadout(text, uuid) from public, anon, authenticated;
grant execute on function public.read_speaking_runtime(text, uuid) to service_role;
grant execute on function public.cas_speaking_runtime(text, uuid, bigint, jsonb, text, integer) to service_role;
grant execute on function public.delete_speaking_runtime(text, uuid) to service_role;
grant execute on function public.get_speaking_loadout(text, uuid) to service_role;

comment on table public.speaking_runtime_state is
  'Private finalized conversation, evidence, policy and leased runtime metadata. Never raw audio or transient audio deltas.';
