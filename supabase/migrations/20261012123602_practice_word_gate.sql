-- Learner-only staged checks. No change to reference acquisition or client grants.
alter table public.practice_analyses
  add column phase text check (phase in ('awaiting_upload','queued_word_check','checking_words','word_check_complete',
    'waiting_reference','analyzing_sound','analyzing_all','finished')),
  add column word_check jsonb,
  add column learner_checkpoint jsonb;

create or replace function public.claim_practice_analysis(p_token uuid,p_seconds integer)
returns setof public.practice_analyses language plpgsql security invoker set search_path='' as $$
begin
  update public.practice_analyses set state='failed',error_code='retry_exhausted',lease_token=null,lease_until=null,
    phase=case when analysis_version='practice-gated-v3' then 'finished' else phase end
    where state='processing' and lease_until<now() and attempts>=3;
  return query update public.practice_analyses set state='processing',attempts=attempts+1,lease_token=p_token,
    lease_until=now()+make_interval(secs=>least(greatest(p_seconds,30),900)),error_code=null
    where id=(select a.id from public.practice_analyses a join public.shadow_attempts s on s.id=a.id
      where (a.state='queued' or (a.state='processing' and a.lease_until<now())) and a.attempts<3
        and a.input_ready and a.input_cleaned_at is null and a.input_expires_at>now() and a.available_at<=now()
        and s.deleted_at is null
        and (
          -- Gated jobs must check words before waiting for reference preparation.
          (a.analysis_version='practice-gated-v3' and (a.word_check is null
            or a.word_check->>'status'<>'reliable' or a.word_check->>'tier'='below_60'))
          or not exists(select 1 from public.acoustic_references r where r.id=a.reference_id
            and r.user_id=a.user_id and r.state in ('awaiting_upload','queued','processing') and r.expires_at>now())
        ) order by a.created_at for update of a skip locked limit 1) returning *;
end $$;

create or replace function public.update_practice_analysis(p_id uuid,p_token uuid,p_action text,p_data jsonb default '{}'::jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare r public.practice_analyses;
begin
  select * into r from public.practice_analyses where id=p_id for update;
  if not found or r.state<>'processing' or r.lease_token is distinct from p_token or r.lease_until<=now()
    or r.input_expires_at<=now() or not exists(select 1 from public.shadow_attempts where id=p_id and deleted_at is null)
    then return false; end if;
  if p_action='heartbeat' then
    update public.practice_analyses set lease_until=now()+make_interval(secs=>least(greatest((p_data->>'seconds')::integer,30),900)) where id=p_id;
  elsif p_action='checkpoint' and r.analysis_version='practice-gated-v3' then
    if p_data ? 'word_check' and r.word_check is not null and r.word_check is distinct from p_data->'word_check'
      then raise exception 'Word check is immutable'; end if;
    update public.practice_analyses set phase=coalesce(p_data->>'phase',phase),
      word_check=coalesce(p_data->'word_check',word_check),
      learner_checkpoint=coalesce(p_data->'learner_checkpoint',learner_checkpoint),
      -- Successful ASR starts a fresh downstream retry budget once.
      attempts=case when r.word_check is null and p_data ? 'word_check' then 0 else attempts end where id=p_id;
  elsif p_action='wait_reference' and r.analysis_version='practice-gated-v3' then
    if r.word_check is null or r.word_check->>'status'<>'reliable'
      or r.word_check->>'tier' not in ('partial_60_85','full_85_plus') then raise exception 'Word check required'; end if;
    update public.practice_analyses set state='queued',phase='waiting_reference',
      attempts=greatest(0,attempts-1),available_at=now()+interval '15 seconds',
      error_code='reference_pending',lease_token=null,lease_until=null where id=p_id;
  elsif p_action='finish' then
    if p_data->>'state' not in ('completed','needs_review','failed') then raise exception 'Invalid final state'; end if;
    update public.practice_analyses set state=p_data->>'state',result=p_data->'result',error_code=p_data->>'error_code',
      phase=case when r.analysis_version='practice-gated-v3' then 'finished' else phase end,
      learner_checkpoint=case when p_data->>'state' in ('completed','needs_review') then null else learner_checkpoint end,
      lease_token=null,lease_until=null where id=p_id;
  elsif p_action='retry' then
    update public.practice_analyses set state=case when attempts<3 then 'queued' else 'failed' end,
      available_at=now()+make_interval(secs=>greatest(1,attempts)*15),error_code=p_data->>'error_code',lease_token=null,lease_until=null where id=p_id;
  else raise exception 'Invalid worker action'; end if;
  return true;
end $$;

create or replace function public.control_practice_analysis(p_id uuid,p_owner text,p_action text)
returns setof public.practice_analyses language plpgsql security invoker set search_path='' as $$
declare r public.practice_analyses;
begin
  select * into r from public.practice_analyses where id=p_id and user_id=p_owner for update;
  if not found then return; end if;
  if p_action='delete' then
    update public.practice_analyses set state='deleted',result=null,snapshot='{}',word_check=null,learner_checkpoint=null,
      phase=case when analysis_version='practice-gated-v3' then 'finished' else phase end,
      lease_token=null,lease_until=null where id=p_id;
  elsif r.state<>'deleted' and exists(select 1 from public.shadow_attempts where id=p_id and deleted_at is null) then
    if p_action='cancel' and r.state in ('awaiting_upload','queued','processing') then
      update public.practice_analyses set state='cancelled',lease_token=null,lease_until=null where id=p_id;
    elsif p_action='upload' and r.state='awaiting_upload' and r.input_cleaned_at is null and r.input_expires_at>now() then
      update public.practice_analyses set state='queued',input_ready=true,
        phase=case when analysis_version='practice-gated-v3' then 'queued_word_check' else phase end where id=p_id;
    elsif p_action='retry' and r.state in ('failed','cancelled') and r.input_cleaned_at is null and r.input_expires_at>now() then
      update public.practice_analyses set state=case when input_ready then 'queued' else 'awaiting_upload' end,
        phase=case when analysis_version<>'practice-gated-v3' then phase
          when not input_ready then 'awaiting_upload' when word_check is null then 'queued_word_check'
          else 'word_check_complete' end,
        attempts=0,error_code=null,available_at=now() where id=p_id;
    end if;
  end if;
  return query select * from public.practice_analyses where id=p_id;
end $$;

create or replace function public.delete_attempt_analysis() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.deleted_at is not null then
    update public.practice_analyses set state='deleted',result=null,snapshot='{}',word_check=null,learner_checkpoint=null,
      phase=case when analysis_version='practice-gated-v3' then 'finished' else phase end,
      lease_token=null,lease_until=null where id=new.id;
  end if;
  return new;
end $$;
-- CREATE OR REPLACE retains existing service-only permissions; assert them in queue regression.
