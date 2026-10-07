-- Stage 5 jobs preserve immutable input and survive API/worker restarts.
-- Legacy reports retain their original fields and remain outside the new queue.
alter table public.speaking_feedback
  alter column task_fit drop not null,
  alter column transfer drop not null,
  alter column scenario_fit drop not null,
  alter column naturalness drop not null,
  add column status text not null default 'ready',
  add column source jsonb,
  add column input_hash text,
  add column rubric_version text,
  add column analysis_version text,
  add column result jsonb,
  add column error_code text,
  add column attempts integer not null default 0,
  add column lease_token uuid,
  add column lease_expires_at timestamptz,
  add column updated_at timestamptz not null default now(),
  add constraint speaking_feedback_status_valid check (
    status in ('queued','processing','ready','partial','insufficient_data','failed')),
  add constraint speaking_feedback_source_valid check (source is null or (
    jsonb_typeof(source) = 'object' and octet_length(source::text) <= 2097152
    and jsonb_typeof(source->'session') = 'object'
    and jsonb_typeof(source->'messages') = 'array'
    and jsonb_typeof(source->'evidence') = 'array'
    and jsonb_typeof(source->'controller'->'exposures') = 'array')),
  add constraint speaking_feedback_hash_valid check (input_hash is null or input_hash ~ '^[a-f0-9]{64}$'),
  add constraint speaking_feedback_result_valid check (result is null or (
    jsonb_typeof(result) = 'object' and octet_length(result::text) <= 1048576)),
  add constraint speaking_feedback_error_valid check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  add constraint speaking_feedback_attempts_valid check (attempts between 0 and 3),
  add constraint speaking_feedback_lease_valid check (
    (status = 'processing' and lease_token is not null and lease_expires_at is not null)
    or (status <> 'processing' and lease_token is null and lease_expires_at is null));

create index speaking_feedback_queue_idx on public.speaking_feedback(created_at)
  where status in ('queued','processing');
-- Existing owner policies cannot expose private snapshots: only server grants exist.
alter table public.speaking_feedback enable row level security;
revoke all on public.speaking_feedback from public, anon, authenticated;
grant select, insert, update, delete on public.speaking_feedback to service_role;

create function public.read_speaking_feedback(p_user_id text, p_session_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'id', f.id, 'session_id', f.session_id, 'user_id', s.user_id,
    'status', f.status, 'source', f.source, 'input_hash', f.input_hash,
    'rubric_version', f.rubric_version, 'analysis_version', f.analysis_version,
    'result', f.result, 'error_code', f.error_code, 'attempts', f.attempts,
    'lease_token', f.lease_token, 'lease_expires_at', f.lease_expires_at,
    'created_at', f.created_at, 'updated_at', f.updated_at
  ) from public.speaking_feedback f join public.speaking_sessions s on s.id = f.session_id
  where s.id = p_session_id and s.user_id = p_user_id and s.client_id is not null
    and s.status = 'completed' and f.source is not null;
$$;

create function public.enqueue_speaking_feedback(p_user_id text, p_session_id uuid, p_retry boolean default false)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_session public.speaking_sessions%rowtype;
  v_job public.speaking_feedback%rowtype;
  v_document jsonb;
  v_source jsonb;
begin
  if p_user_id is null or length(btrim(p_user_id)) = 0 or p_session_id is null or p_retry is null then
    raise sqlstate 'PT422' using message = 'Invalid speaking feedback state.';
  end if;
  -- Runtime CAS, enqueue, complete and deletion serialize on this same parent.
  select * into v_session from public.speaking_sessions
    where id = p_session_id and user_id = p_user_id and client_id is not null for update;
  if not found then return null; end if;
  if v_session.status <> 'completed' then
    raise sqlstate 'PT409' using message = 'End this session before requesting feedback.';
  end if;
  select * into v_job from public.speaking_feedback where session_id = p_session_id for update;
  if found then
    if v_job.source is null then
      raise sqlstate 'PT422' using message = 'Legacy feedback cannot be reprocessed.';
    end if;
    if p_retry and v_job.status in ('partial','failed') and v_job.attempts < 3
      and coalesce(v_job.error_code,'') not in ('input_limit','worker_version_mismatch') then
      update public.speaking_feedback set status = 'queued', error_code = null,
        lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
        where id = v_job.id;
    end if;
    return public.read_speaking_feedback(p_user_id, p_session_id);
  end if;
  select document into v_document from public.speaking_runtime_state where session_id = p_session_id;
  v_document := coalesce(v_document, '{}'::jsonb);
  -- Do not copy the private runtime, authentication ticket or provider instructions.
  v_source := jsonb_build_object(
    'session', public.get_speaking_loadout(p_user_id, p_session_id),
    'messages', coalesce((select jsonb_agg((select coalesce(jsonb_object_agg(key,value), '{}'::jsonb)
      from jsonb_each(row) where key = any(array['id','ordinal','role','text','input_source','status',
        'revision','provider_item_id','response_id','client_turn_id','created_at'])) order by ord)
      from jsonb_array_elements(coalesce(v_document->'messages','[]'::jsonb)) with ordinality as m(row,ord)
      where jsonb_typeof(row) = 'object'), '[]'::jsonb),
    'evidence', coalesce((select jsonb_agg((select coalesce(jsonb_object_agg(key,value), '{}'::jsonb)
      from jsonb_each(row) where key = any(array['id','session_item_id','message_id','transcript_revision',
        'start','end','quote','match_type','appropriateness','prompted','reason'])) order by ord)
      from jsonb_array_elements(coalesce(v_document->'evidence','[]'::jsonb)) with ordinality as e(row,ord)
      where jsonb_typeof(row) = 'object'), '[]'::jsonb),
    'controller', jsonb_build_object('exposures', coalesce((select jsonb_agg((select
      coalesce(jsonb_object_agg(key,value), '{}'::jsonb) from jsonb_each(row)
      where key = any(array['id','target_item_id','source_message_id','source_revision','after_turn'])) order by ord)
      from jsonb_array_elements(coalesce(v_document->'controller'->'exposures','[]'::jsonb))
        with ordinality as x(row,ord) where jsonb_typeof(row) = 'object'), '[]'::jsonb))
  );
  if octet_length(v_source::text) > 2097152 then
    raise sqlstate 'PT422' using message = 'Invalid speaking feedback state.';
  end if;
  insert into public.speaking_feedback(session_id,status,source,input_hash,rubric_version,analysis_version)
    values (p_session_id,'queued',v_source,encode(extensions.digest(v_source::text, 'sha256'),'hex'),
      'speaking-rubric-v1','speaking-feedback-v1');
  return public.read_speaking_feedback(p_user_id, p_session_id);
end;
$$;

create function public.claim_speaking_feedback(p_job_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_candidate record;
  v_job public.speaking_feedback%rowtype;
begin
  -- Lock parents first; SKIP LOCKED makes competing workers claim different jobs.
  for v_candidate in
    select s.id, s.user_id from public.speaking_sessions s
    join public.speaking_feedback f on f.session_id = s.id
    where s.status = 'completed' and s.client_id is not null and f.source is not null
      and (p_job_id is null or f.id = p_job_id)
      and (f.status = 'queued' or (f.status = 'processing' and f.lease_expires_at <= clock_timestamp()))
    order by f.created_at limit 100 for update of s skip locked
  loop
    select * into v_job from public.speaking_feedback where session_id = v_candidate.id for update;
    if v_job.attempts >= 3 then
      update public.speaking_feedback set status = 'failed', error_code = 'retry_limit_reached',
        lease_token = null, lease_expires_at = null, updated_at = clock_timestamp() where id = v_job.id;
      continue;
    end if;
    update public.speaking_feedback set status = 'processing', attempts = attempts + 1,
      lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '120 seconds',
      updated_at = clock_timestamp() where id = v_job.id;
    return public.read_speaking_feedback(v_candidate.user_id, v_candidate.id);
  end loop;
  return null;
end;
$$;

create function public.complete_speaking_feedback(
  p_job_id uuid, p_lease_token uuid, p_status text, p_result jsonb, p_error_code text default null
)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_session_id uuid;
begin
  if p_job_id is null or p_lease_token is null or p_status is null
    or p_status not in ('ready','partial','insufficient_data','failed')
    or (p_result is null and p_status <> 'failed')
    or (p_result is not null and (jsonb_typeof(p_result) <> 'object' or octet_length(p_result::text) > 1048576))
    or (p_error_code is not null and p_error_code !~ '^[a-z][a-z0-9_]{0,63}$') then
    raise sqlstate 'PT422' using message = 'Invalid speaking feedback state.';
  end if;
  select s.id into v_session_id from public.speaking_sessions s
    join public.speaking_feedback f on f.session_id = s.id
    where f.id = p_job_id and s.status = 'completed' and s.client_id is not null for update of s;
  if not found then return false; end if;
  update public.speaking_feedback set status = p_status, result = p_result, error_code = p_error_code,
    lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
    where id = p_job_id and status = 'processing' and lease_token = p_lease_token
      and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

create function public.pending_speaking_feedback_sessions(p_limit integer default 10)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise sqlstate 'PT422' using message = 'Invalid speaking feedback state.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('session_id',x.id,'user_id',x.user_id))
    from (select s.id,s.user_id from public.speaking_sessions s
      join public.speaking_runtime_state r on r.session_id = s.id
      where s.status = 'completed' and s.client_id is not null
        and not exists (select 1 from public.speaking_feedback f where f.session_id = s.id)
      order by s.completed_at,s.id limit p_limit) x), '[]'::jsonb);
end;
$$;

revoke all on function public.read_speaking_feedback(text,uuid) from public,anon,authenticated;
revoke all on function public.enqueue_speaking_feedback(text,uuid,boolean) from public,anon,authenticated;
revoke all on function public.claim_speaking_feedback(uuid) from public,anon,authenticated;
revoke all on function public.complete_speaking_feedback(uuid,uuid,text,jsonb,text) from public,anon,authenticated;
revoke all on function public.pending_speaking_feedback_sessions(integer) from public,anon,authenticated;
grant execute on function public.read_speaking_feedback(text,uuid) to service_role;
grant execute on function public.enqueue_speaking_feedback(text,uuid,boolean) to service_role;
grant execute on function public.claim_speaking_feedback(uuid) to service_role;
grant execute on function public.complete_speaking_feedback(uuid,uuid,text,jsonb,text) to service_role;
grant execute on function public.pending_speaking_feedback_sessions(integer) to service_role;
