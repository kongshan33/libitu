-- Drain older workers before applying. Existing leases are not transferred.
alter table public.practice_analyses add column worker_lane text not null default 'fast'
  check (worker_lane in ('fast','fine'));
alter table public.acoustic_references add column worker_lane text not null default 'fast'
  check (worker_lane in ('fast','fine'));
-- Older policies need the compatibility processor, which belongs only to fine.
update public.practice_analyses set worker_lane='fine' where analysis_version<>'practice-gated-v3';
create function public.route_legacy_analysis_lane() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.analysis_version<>'practice-gated-v3' then new.worker_lane='fine'; end if;
  return new;
end $$;
create trigger route_legacy_analysis_lane before insert on public.practice_analyses
for each row execute function public.route_legacy_analysis_lane();
create index practice_analysis_lane_queue on public.practice_analyses(worker_lane,created_at)
  where state in ('queued','processing');
create index acoustic_reference_lane_queue on public.acoustic_references(worker_lane,created_at)
  where state in ('queued','processing');

create or replace function public.claim_practice_analysis_lane(p_token uuid,p_seconds integer,p_lane text)
returns setof public.practice_analyses language plpgsql security invoker set search_path='' as $$
begin
  if p_lane not in ('fast','fine') or p_lane is null then raise exception 'Invalid worker lane'; end if;
  update public.practice_analyses set state='failed',error_code='retry_exhausted',lease_token=null,lease_until=null,
    phase=case when analysis_version='practice-gated-v3' then 'finished' else phase end
    where worker_lane=p_lane and state='processing' and lease_until<now() and attempts>=3;
  return query update public.practice_analyses set state='processing',attempts=attempts+1,lease_token=p_token,
    lease_until=now()+make_interval(secs=>least(greatest(p_seconds,30),900)),error_code=null
    where id=(select a.id from public.practice_analyses a join public.shadow_attempts s on s.id=a.id
      where a.worker_lane=p_lane and (a.state='queued' or (a.state='processing' and a.lease_until<now())) and a.attempts<3
        and a.input_ready and a.input_cleaned_at is null and a.input_expires_at>now() and a.available_at<=now()
        and s.deleted_at is null
        and (
          -- Compute and checkpoint learner acoustics before waiting for reference preparation.
          p_lane='fast' or (a.analysis_version='practice-gated-v3' and (a.word_check is null
            or a.learner_checkpoint is null or a.word_check->>'status'<>'reliable' or a.word_check->>'tier'='below_60'))
          or not exists(select 1 from public.acoustic_references r where r.id=a.reference_id
            and r.user_id=a.user_id and r.state in ('awaiting_upload','queued','processing') and r.expires_at>now())
        ) order by a.created_at for update of a skip locked limit 1) returning *;
end $$;


create function public.claim_acoustic_reference_lane(p_token uuid, p_seconds integer, p_lane text)
returns setof public.acoustic_references language plpgsql security invoker set search_path = '' as $$
begin
  if p_lane not in ('fast','fine') or p_lane is null then raise exception 'Invalid worker lane'; end if;
  update public.acoustic_references set state='failed', error_code='retry_exhausted', lease_token=null, lease_until=null
    where worker_lane=p_lane and state='processing' and lease_until < now() and attempts >= 3;
  return query update public.acoustic_references set state='processing', attempts=attempts+1,
    lease_token=p_token, lease_until=now()+make_interval(secs => least(greatest(p_seconds,30),900)), error_code=null
    where id=(select id from public.acoustic_references
      where worker_lane=p_lane and (state='queued' or (state='processing' and lease_until < now()))
        and available_at <= now() and expires_at > now() and attempts < 3
      order by created_at for update skip locked limit 1)
    returning *;
end $$;


-- Handoff is a fenced transition, never a second enqueue operation.
create function public.handoff_acoustic_job(p_kind text,p_id uuid,p_token uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
declare a public.practice_analyses; r public.acoustic_references;
begin
  if p_kind='take' then
    select * into a from public.practice_analyses where id=p_id for update;
    if not found or a.state<>'processing' or a.worker_lane<>'fast' or a.lease_token is distinct from p_token
      or a.lease_until<=now() or a.input_expires_at<=now() or not exists
        (select 1 from public.shadow_attempts where id=p_id and deleted_at is null) then return false; end if;
    if a.word_check is null or a.word_check->>'status' is distinct from 'reliable'
      or coalesce(a.word_check->>'tier','') not in ('partial_60_85','full_85_plus')
      then raise exception 'Eligible word check required'; end if;
    if a.word_check->>'tier'='full_85_plus' and a.snapshot->>'progressive_version'='server-prominence-v1'
      and (a.acoustic_checkpoint is null or a.coarse_checkpoint is null)
      then raise exception 'Coarse checkpoint required'; end if;
    update public.practice_analyses set worker_lane='fine',state='queued',attempts=0,
      available_at=now(),lease_token=null,lease_until=null where id=p_id;
  elsif p_kind='reference' then
    select * into r from public.acoustic_references where id=p_id for update;
    if not found or r.state<>'processing' or r.worker_lane<>'fast' or r.lease_token is distinct from p_token
      or r.lease_until<=now() or r.expires_at<=now() then return false; end if;
    if not r.audio_ready or coalesce(jsonb_array_length(r.snapshot->'sentences'),0)=0 or exists (
      select 1 from jsonb_array_elements(r.snapshot->'sentences') s where not exists (
        select 1 from jsonb_array_elements(r.results) x where x->>'sentence_id'=s->>'id'
          and jsonb_typeof(x->'measurements')='object' and jsonb_typeof(x->'coarse')='object'))
      then raise exception 'Reference signal checkpoint required'; end if;
    update public.acoustic_references set worker_lane='fine',state='queued',attempts=0,
      available_at=now(),lease_token=null,lease_until=null where id=p_id;
  else raise exception 'Invalid acoustic job kind'; end if;
  return true;
end $$;

-- Old deployed workers fail visibly instead of stealing jobs from either lane.
create or replace function public.claim_practice_analysis(p_token uuid,p_seconds integer)
returns setof public.practice_analyses language plpgsql security invoker set search_path='' as $$
begin raise exception 'Restart with stage_two_worker --lane fast and --lane fine'; end $$;
create or replace function public.claim_acoustic_reference(p_token uuid,p_seconds integer)
returns setof public.acoustic_references language plpgsql security invoker set search_path='' as $$
begin raise exception 'Restart with stage_two_worker --lane fast and --lane fine'; end $$;

revoke all on function public.claim_practice_analysis_lane(uuid,integer,text),
  public.claim_acoustic_reference_lane(uuid,integer,text), public.handoff_acoustic_job(text,uuid,uuid),
  public.route_legacy_analysis_lane() from public,anon,authenticated;
grant execute on function public.claim_practice_analysis_lane(uuid,integer,text),
  public.claim_acoustic_reference_lane(uuid,integer,text), public.handoff_acoustic_job(text,uuid,uuid),
  public.route_legacy_analysis_lane() to service_role;
