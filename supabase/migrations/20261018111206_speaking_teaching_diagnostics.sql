-- Detailed provider traces do not share the 1 MiB realtime state or its CAS version.
-- The owner is obtained from Clerk by FastAPI; browser roles cannot access this table.
create table public.speaking_diagnostic_events (
  session_id uuid not null references public.speaking_sessions(id) on delete cascade,
  id uuid not null,
  kind text not null check (kind ~ '^[a-z][a-z0-9_.-]{0,79}$'),
  created_at timestamptz not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  expires_at timestamptz not null default (now() + interval '30 days'),
  primary key (session_id, id),
  constraint speaking_diagnostic_payload_size check (octet_length(payload::text) <= 131072)
);

create index speaking_diagnostics_session_cursor
  on public.speaking_diagnostic_events (session_id, created_at desc, id desc);
create index speaking_diagnostics_expiry on public.speaking_diagnostic_events (expires_at);

alter table public.speaking_diagnostic_events enable row level security;
-- Explicitly reset service_role too: hosted default privileges may have granted UPDATE.
revoke all on public.speaking_diagnostic_events from public, anon, authenticated, service_role;
grant select, insert, delete on public.speaking_diagnostic_events to service_role;
create policy speaking_diagnostics_server_only on public.speaking_diagnostic_events
  for all to service_role using (true) with check (true);

create function public.append_speaking_diagnostic(p_user_id text, p_session_id uuid, p_event jsonb)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_created_at timestamptz;
begin
  if p_user_id is null or length(btrim(p_user_id)) = 0 or p_session_id is null
    or p_event is null or jsonb_typeof(p_event) <> 'object'
    or not (p_event ?& array['id', 'kind', 'created_at', 'payload'])
    or p_event - array['id', 'kind', 'created_at', 'payload'] <> '{}'::jsonb
    or jsonb_typeof(p_event->'kind') <> 'string'
    or (p_event->>'kind') !~ '^[a-z][a-z0-9_.-]{0,79}$'
    or jsonb_typeof(p_event->'payload') <> 'object'
    or octet_length((p_event->'payload')::text) > 131072
    or jsonb_typeof(p_event->'created_at') <> 'string'
    or jsonb_typeof(p_event->'id') <> 'string'
  then
    raise sqlstate 'PT422' using message = 'Invalid speaking diagnostic event or cursor.';
  end if;
  begin
    v_id := (p_event->>'id')::uuid;
    v_created_at := (p_event->>'created_at')::timestamptz;
    if not isfinite(v_created_at) then
      raise sqlstate 'PT422' using message = 'Invalid speaking diagnostic event or cursor.';
    end if;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise sqlstate 'PT422' using message = 'Invalid speaking diagnostic event or cursor.';
  end;

  -- The key-share lock coordinates deletion, but does not update live session state.
  perform 1 from public.speaking_sessions
    where id = p_session_id and user_id = p_user_id and client_id is not null for key share;
  if not found then
    return null;
  end if;
  delete from public.speaking_diagnostic_events where session_id = p_session_id and expires_at <= now();
  insert into public.speaking_diagnostic_events(session_id, id, kind, created_at, payload)
    values (p_session_id, v_id, p_event->>'kind', v_created_at, p_event->'payload')
    on conflict (session_id, id) do nothing;
  return found;
end;
$$;

create function public.read_speaking_diagnostics(
  p_user_id text, p_session_id uuid, p_limit integer default 200, p_before uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_before_at timestamptz;
  v_events jsonb;
  v_has_more boolean;
begin
  if p_user_id is null or length(btrim(p_user_id)) = 0 or p_session_id is null
    or p_limit is null or p_limit not between 1 and 200
  then
    raise sqlstate 'PT422' using message = 'Invalid speaking diagnostic event or cursor.';
  end if;
  perform 1 from public.speaking_sessions
    where id = p_session_id and user_id = p_user_id and client_id is not null;
  if not found then
    return null;
  end if;
  if p_before is not null then
    select created_at into v_before_at from public.speaking_diagnostic_events
      where session_id = p_session_id and id = p_before and expires_at > now();
    if not found then
      raise sqlstate 'PT422' using message = 'Invalid speaking diagnostic event or cursor.';
    end if;
  end if;
  with candidates as (
    select id, kind, created_at, payload from public.speaking_diagnostic_events
    where session_id = p_session_id and expires_at > now()
      and (p_before is null or (created_at, id) < (v_before_at, p_before))
    order by created_at desc, id desc limit p_limit + 1
  ), page as (
    select * from candidates order by created_at desc, id desc limit p_limit
  )
  select coalesce((select jsonb_agg(jsonb_build_object(
    'id', id, 'kind', kind, 'created_at', created_at, 'payload', payload
  ) order by created_at desc, id desc) from page), '[]'::jsonb),
    (select count(*) > p_limit from candidates)
  into v_events, v_has_more;
  return jsonb_build_object('events', v_events, 'limit', p_limit,
    'next_before', case when v_has_more then v_events->-1->>'id' else null end);
end;
$$;

-- Can be invoked by an existing server maintenance job; this migration adds no cron job.
-- Reads always exclude expired data, and append also prunes the owning session.
create function public.purge_expired_speaking_diagnostics()
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count bigint;
begin
  delete from public.speaking_diagnostic_events where expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.append_speaking_diagnostic(text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.read_speaking_diagnostics(text, uuid, integer, uuid) from public, anon, authenticated;
revoke all on function public.purge_expired_speaking_diagnostics() from public, anon, authenticated;
grant execute on function public.append_speaking_diagnostic(text, uuid, jsonb) to service_role;
grant execute on function public.read_speaking_diagnostics(text, uuid, integer, uuid) to service_role;
grant execute on function public.purge_expired_speaking_diagnostics() to service_role;

comment on table public.speaking_diagnostic_events is
  'Private append-only teaching analysis, policy execution and hint presentation traces. No credentials or raw audio. Session deletion cascades; reads retain 30 days.';
