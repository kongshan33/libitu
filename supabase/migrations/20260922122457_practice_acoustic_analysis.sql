-- Attempt-bound learner analysis. Client roles access neither the queue nor input objects.
create table public.practice_analyses (
  id uuid primary key references public.shadow_attempts(id),
  user_id text not null references public.profiles(id),
  reference_id uuid references public.acoustic_references(id),
  request_hash text not null,
  input_sha256 text not null check (input_sha256 ~ '^[a-f0-9]{64}$'),
  input_bytes integer not null check (input_bytes between 1 and 8388608),
  input_mime text not null check (input_mime in ('audio/webm','audio/ogg','audio/mp4')),
  consent_version text not null check (consent_version='practice-analysis-v1'),
  consent_at timestamptz not null default now(),
  analysis_version text not null,
  snapshot jsonb not null,
  state text not null check (state in ('awaiting_upload','queued','processing','completed','needs_review','failed','cancelled','deleted')),
  input_ready boolean not null default false,
  result jsonb,
  error_code text,
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz not null default now(),
  input_expires_at timestamptz not null default now()+interval '1 day',
  input_cleaned_at timestamptz,
  created_at timestamptz not null default now()
);
create index practice_analysis_owner_idx on public.practice_analyses(user_id,created_at desc);
create index practice_analysis_reference_idx on public.practice_analyses(reference_id);
create index practice_analysis_queue_idx on public.practice_analyses(available_at,created_at) where state in ('queued','processing');
create index practice_analysis_cleanup_idx on public.practice_analyses(input_expires_at) where input_cleaned_at is null;
alter table public.practice_analyses enable row level security;
revoke all on public.practice_analyses from public,anon,authenticated;
grant select,insert,update,delete on public.practice_analyses to service_role;
create policy practice_analysis_service on public.practice_analyses to service_role using(true) with check(true);

create function public.claim_practice_analysis(p_token uuid,p_seconds integer)
returns setof public.practice_analyses language plpgsql security invoker set search_path='' as $$
begin
  update public.practice_analyses set state='failed',error_code='retry_exhausted',lease_token=null,lease_until=null
    where state='processing' and lease_until<now() and attempts>=3;
  return query update public.practice_analyses set state='processing',attempts=attempts+1,lease_token=p_token,
    lease_until=now()+make_interval(secs=>least(greatest(p_seconds,30),900)),error_code=null
    where id=(select a.id from public.practice_analyses a join public.shadow_attempts s on s.id=a.id
      where (a.state='queued' or (a.state='processing' and a.lease_until<now())) and a.attempts<3
        and a.input_ready and a.input_cleaned_at is null and a.input_expires_at>now() and a.available_at<=now()
        and s.deleted_at is null order by a.created_at for update of a skip locked limit 1) returning *;
end $$;

create function public.update_practice_analysis(p_id uuid,p_token uuid,p_action text,p_data jsonb default '{}'::jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare r public.practice_analyses;
begin
  select * into r from public.practice_analyses where id=p_id for update;
  if not found or r.state<>'processing' or r.lease_token is distinct from p_token or r.lease_until<=now()
    or r.input_expires_at<=now() or not exists(select 1 from public.shadow_attempts where id=p_id and deleted_at is null)
    then return false; end if;
  if p_action='heartbeat' then
    update public.practice_analyses set lease_until=now()+make_interval(secs=>least(greatest((p_data->>'seconds')::integer,30),900)) where id=p_id;
  elsif p_action='finish' then
    if p_data->>'state' not in ('completed','needs_review','failed') then raise exception 'Invalid final state'; end if;
    update public.practice_analyses set state=p_data->>'state',result=p_data->'result',error_code=p_data->>'error_code',
      lease_token=null,lease_until=null where id=p_id;
  elsif p_action='retry' then
    update public.practice_analyses set state=case when attempts<3 then 'queued' else 'failed' end,
      available_at=now()+make_interval(secs=>attempts*15),error_code=p_data->>'error_code',lease_token=null,lease_until=null where id=p_id;
  else raise exception 'Invalid worker action'; end if;
  return true;
end $$;

create function public.control_practice_analysis(p_id uuid,p_owner text,p_action text)
returns setof public.practice_analyses language plpgsql security invoker set search_path='' as $$
declare r public.practice_analyses;
begin
  select * into r from public.practice_analyses where id=p_id and user_id=p_owner for update;
  if not found then return; end if;
  if p_action='delete' then
    update public.practice_analyses set state='deleted',result=null,snapshot='{}',lease_token=null,lease_until=null where id=p_id;
  elsif r.state<>'deleted' and exists(select 1 from public.shadow_attempts where id=p_id and deleted_at is null) then
    if p_action='cancel' and r.state in ('awaiting_upload','queued','processing') then
      update public.practice_analyses set state='cancelled',lease_token=null,lease_until=null where id=p_id;
    elsif p_action='upload' and r.state='awaiting_upload' and r.input_cleaned_at is null and r.input_expires_at>now() then
      update public.practice_analyses set state='queued',input_ready=true where id=p_id;
    elsif p_action='retry' and r.state in ('failed','cancelled') and r.input_cleaned_at is null and r.input_expires_at>now() then
      update public.practice_analyses set state=case when input_ready then 'queued' else 'awaiting_upload' end,
        attempts=0,error_code=null,available_at=now() where id=p_id;
    end if;
  end if;
  return query select * from public.practice_analyses where id=p_id;
end $$;

-- A deleted practice record immediately fences its analysis, even before storage cleanup succeeds.
create function public.delete_attempt_analysis() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.deleted_at is not null then
    update public.practice_analyses set state='deleted',result=null,snapshot='{}',lease_token=null,lease_until=null where id=new.id;
  end if;
  return new;
end $$;
create trigger delete_attempt_analysis after update of deleted_at on public.shadow_attempts
for each row execute function public.delete_attempt_analysis();
revoke all on function public.claim_practice_analysis(uuid,integer),public.update_practice_analysis(uuid,uuid,text,jsonb),
  public.control_practice_analysis(uuid,text,text),public.delete_attempt_analysis() from public,anon,authenticated;
grant execute on function public.claim_practice_analysis(uuid,integer),public.update_practice_analysis(uuid,uuid,text,jsonb),
  public.control_practice_analysis(uuid,text,text),public.delete_attempt_analysis() to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('practice-analysis-inputs','practice-analysis-inputs',false,8388608,array['audio/webm','audio/ogg','audio/mp4']);
