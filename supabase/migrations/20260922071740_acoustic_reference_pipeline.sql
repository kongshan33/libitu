-- Private reference asset + durable work item. No client table/storage access.
create table public.acoustic_references (
  id uuid primary key,
  user_id text not null references public.profiles(id),
  content_id uuid not null references public.contents(id),
  segment_id text not null,
  source_id text not null,
  source_fingerprint text not null check (source_fingerprint ~ '^[a-f0-9]{64}$'),
  input_mode text not null check (input_mode in ('file','upload')),
  input_sha256 text not null check (input_sha256 ~ '^[a-f0-9]{64}$'),
  analysis_version text not null,
  snapshot jsonb not null,
  start_ms bigint not null check (start_ms >= 0),
  end_ms bigint not null check (end_ms > start_ms and end_ms - start_ms <= 600000),
  state text not null check (state in ('awaiting_upload','queued','processing','completed','partially_completed','failed','cancelled','deleted')),
  audio_ready boolean not null default false,
  audio_sha256 text,
  results jsonb not null default '[]'::jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz not null default now(),
  error_code text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  deleted_at timestamptz,
  cleanup_at timestamptz,
  check (jsonb_typeof(results) = 'array')
);
create index acoustic_reference_owner_idx on public.acoustic_references(user_id, content_id, segment_id);
create index acoustic_reference_content_idx on public.acoustic_references(content_id);
create index acoustic_reference_queue_idx on public.acoustic_references(available_at, created_at) where state in ('queued','processing');
create index acoustic_reference_expiry_idx on public.acoustic_references(expires_at) where state <> 'deleted';
alter table public.acoustic_references enable row level security;
revoke all on public.acoustic_references from public, anon, authenticated;
grant select, insert, update, delete on public.acoustic_references to service_role;
create policy acoustic_reference_service on public.acoustic_references to service_role using (true) with check (true);

create function public.claim_acoustic_reference(p_token uuid, p_seconds integer)
returns setof public.acoustic_references language plpgsql security invoker set search_path = '' as $$
begin
  update public.acoustic_references set state='failed', error_code='retry_exhausted', lease_token=null, lease_until=null
    where state='processing' and lease_until < now() and attempts >= 3;
  return query update public.acoustic_references set state='processing', attempts=attempts+1,
    lease_token=p_token, lease_until=now()+make_interval(secs => least(greatest(p_seconds,30),900)), error_code=null
    where id=(select id from public.acoustic_references
      where (state='queued' or (state='processing' and lease_until < now()))
        and available_at <= now() and expires_at > now() and attempts < 3
      order by created_at for update skip locked limit 1)
    returning *;
end $$;

-- Every worker write is fenced by its unique lease token and expiry.
create function public.update_acoustic_reference(p_id uuid, p_token uuid, p_action text, p_data jsonb default '{}'::jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare r public.acoustic_references;
begin
  select * into r from public.acoustic_references where id=p_id for update;
  if not found or r.state <> 'processing' or r.lease_token is distinct from p_token
      or r.lease_until <= now() or r.expires_at <= now() then return false; end if;
  if p_action='heartbeat' then
    update public.acoustic_references set lease_until=now()+make_interval(secs => least(greatest((p_data->>'seconds')::integer,30),900)) where id=p_id;
  elsif p_action='audio' then
    update public.acoustic_references set audio_ready=true, audio_sha256=p_data->>'sha256' where id=p_id;
  elsif p_action='results' then
    update public.acoustic_references set results=p_data->'results' where id=p_id;
  elsif p_action='finish' then
    if p_data->>'state' not in ('completed','partially_completed','failed') then raise exception 'Invalid final state'; end if;
    update public.acoustic_references set state=p_data->>'state', error_code=p_data->>'error_code', lease_token=null, lease_until=null where id=p_id;
  elsif p_action='retry' then
    update public.acoustic_references set state=case when attempts < 3 then 'queued' else 'failed' end,
      available_at=now()+make_interval(secs => attempts*15), error_code=p_data->>'error_code', lease_token=null, lease_until=null where id=p_id;
  else raise exception 'Invalid worker action'; end if;
  return true;
end $$;

create function public.control_acoustic_reference(p_id uuid, p_owner text, p_action text, p_hash text default null)
returns setof public.acoustic_references language plpgsql security invoker set search_path = '' as $$
declare r public.acoustic_references;
begin
  select * into r from public.acoustic_references where id=p_id and user_id=p_owner for update;
  if not found then return; end if;
  if p_action='delete' then
    update public.acoustic_references set state='deleted', deleted_at=coalesce(deleted_at,now()),
      audio_ready=false, results='[]'::jsonb, snapshot='{}'::jsonb, lease_token=null, lease_until=null where id=p_id;
  elsif r.state <> 'deleted' and r.expires_at > now() then
    if p_action='cancel' and r.state in ('queued','processing','awaiting_upload') then
      update public.acoustic_references set state='cancelled', lease_token=null, lease_until=null where id=p_id;
    elsif p_action='retry' and r.state in ('failed','cancelled','partially_completed') then
      update public.acoustic_references set state=case when input_mode='upload' and not audio_ready then 'awaiting_upload' else 'queued' end,
        attempts=0, available_at=now(), error_code=null where id=p_id;
    elsif p_action='upload' and r.state='awaiting_upload' and p_hash ~ '^[a-f0-9]{64}$' then
      update public.acoustic_references set state='queued', audio_ready=true, audio_sha256=p_hash where id=p_id;
    end if;
  end if;
  return query select * from public.acoustic_references where id=p_id;
end $$;

revoke all on function public.claim_acoustic_reference(uuid,integer) from public, anon, authenticated;
revoke all on function public.update_acoustic_reference(uuid,uuid,text,jsonb) from public, anon, authenticated;
revoke all on function public.control_acoustic_reference(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.claim_acoustic_reference(uuid,integer) to service_role;
grant execute on function public.update_acoustic_reference(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.control_acoustic_reference(uuid,text,text,text) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('reference-audio','reference-audio',false,33554432,array['audio/wav']);
