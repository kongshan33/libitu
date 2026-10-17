-- Private, durable full frames and MFA-independent display checkpoints.
alter table public.practice_analyses
  add column acoustic_checkpoint jsonb,
  add column coarse_checkpoint jsonb;
alter table public.practice_analyses drop constraint practice_analyses_phase_check;
alter table public.practice_analyses add constraint practice_analyses_phase_check check
  (phase in ('awaiting_upload','queued_word_check','checking_words','word_check_complete',
    'waiting_reference','analyzing_sound','analyzing_all','coarse_ready','finished'));

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
    if (p_data ? 'coarse_checkpoint' or p_data ? 'acoustic_checkpoint') and
      (r.word_check is null or r.word_check->>'status'<>'reliable' or r.word_check->>'tier'<>'full_85_plus')
      then raise exception 'Full word gate required'; end if;
    if p_data ? 'coarse_checkpoint' and r.acoustic_checkpoint is null and not p_data ? 'acoustic_checkpoint'
      then raise exception 'Acoustic checkpoint required'; end if;
    if p_data ? 'acoustic_checkpoint' and r.acoustic_checkpoint is not null
      and r.acoustic_checkpoint is distinct from p_data->'acoustic_checkpoint'
      then raise exception 'Acoustic checkpoint is immutable'; end if;
    update public.practice_analyses set phase=coalesce(p_data->>'phase',phase),
      word_check=coalesce(p_data->'word_check',word_check),
      acoustic_checkpoint=coalesce(p_data->'acoustic_checkpoint',acoustic_checkpoint),
      coarse_checkpoint=coalesce(p_data->'coarse_checkpoint',coarse_checkpoint),
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
    update public.practice_analyses set state='deleted',result=null,snapshot='{}',word_check=null,learner_checkpoint=null,acoustic_checkpoint=null,coarse_checkpoint=null,
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
    update public.practice_analyses set state='deleted',result=null,snapshot='{}',word_check=null,learner_checkpoint=null,acoustic_checkpoint=null,coarse_checkpoint=null,
      phase=case when analysis_version='practice-gated-v3' then 'finished' else phase end,
      lease_token=null,lease_until=null where id=new.id;
  end if;
  return new;
end $$;
-- CREATE OR REPLACE retains existing service-only permissions; assert them in queue regression.
