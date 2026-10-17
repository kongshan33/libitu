-- Service-only registration: one transaction for profile, frozen Take and analysis.
create function public.practice_submission_context(p_owner text,p_id uuid) returns jsonb
language sql security invoker set search_path='' as $$
  select jsonb_build_object('attempt',to_jsonb(s),'analysis',to_jsonb(a)-'acoustic_checkpoint'-'learner_checkpoint'-'coarse_checkpoint'-'result')
  from public.shadow_attempts s left join public.practice_analyses a on a.id=s.id and a.user_id=p_owner
  where s.id=p_id and s.user_id=p_owner;
$$;

create function public.register_practice_submission(p_owner text,p_attempt jsonb,p_analysis jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s public.shadow_attempts; a public.practice_analyses;
  candidate public.shadow_attempts; job public.practice_analyses;
begin
  candidate=jsonb_populate_record(null::public.shadow_attempts,p_attempt);
  job=jsonb_populate_record(null::public.practice_analyses,p_analysis);
  if candidate.user_id is distinct from p_owner or job.user_id is distinct from p_owner
    or candidate.id is distinct from job.id then raise exception using errcode='PT409',message='Invalid submission identity'; end if;
  if not exists(select 1 from public.contents where id=candidate.content_id
      and (visibility='public' or owner_user_id=p_owner)) then
    raise exception using errcode='PT404',message='Practice source unavailable'; end if;
  insert into public.profiles(id) values(p_owner) on conflict(id) do nothing;
  insert into public.shadow_attempts(id,user_id,content_id,sentence_id,sentence_text,start_ms,end_ms,reference_version,
    duration_ms,playback_rate,text_visible,request_hash,text_support,recording_state,recording_sha256,recording_bytes,
    recording_mime,recording_consent_at,consent_version)
  values(candidate.id,p_owner,candidate.content_id,candidate.sentence_id,candidate.sentence_text,candidate.start_ms,
    candidate.end_ms,candidate.reference_version,candidate.duration_ms,candidate.playback_rate,candidate.text_visible,
    candidate.request_hash,candidate.text_support,candidate.recording_state,candidate.recording_sha256,candidate.recording_bytes,
    candidate.recording_mime,candidate.recording_consent_at,candidate.consent_version) on conflict(id) do nothing;
  select * into s from public.shadow_attempts where id=candidate.id for update;
  if s.user_id is distinct from p_owner or s.deleted_at is not null or s.request_hash is distinct from candidate.request_hash
    then raise exception using errcode='PT409',message='Take deleted or submission changed'; end if;
  if s.recording_state='deleted' and candidate.recording_sha256 is not null
    then raise exception using errcode='PT409',message='Recording retention deleted'; end if;
  -- Store the already server-validated snapshot only on first registration.
  insert into public.practice_analyses(id,user_id,reference_id,request_hash,input_sha256,input_bytes,input_mime,
    consent_version,analysis_version,snapshot,state,phase)
  values(s.id,p_owner,job.reference_id,job.request_hash,job.input_sha256,job.input_bytes,job.input_mime,
    job.consent_version,job.analysis_version,job.snapshot,'awaiting_upload','awaiting_upload') on conflict(id) do nothing;
  select * into a from public.practice_analyses where id=s.id for update;
  if a.user_id is distinct from p_owner or a.state='deleted' or a.request_hash is distinct from job.request_hash
    then raise exception using errcode='PT409',message='Analysis deleted or submission changed'; end if;
  return public.practice_submission_context(p_owner,s.id);
end $$;

-- Called only after durable object upload succeeds. Cancellation/deletion wins.
create function public.finalize_practice_submission(p_owner text,p_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s public.shadow_attempts; a public.practice_analyses;
begin
  select * into s from public.shadow_attempts where id=p_id and user_id=p_owner for update;
  if not found or s.deleted_at is not null then
    raise exception using errcode='PT409',message='Take deleted'; end if;
  select * into a from public.practice_analyses where id=p_id and user_id=p_owner for update;
  if not found or a.state='deleted' then raise exception using errcode='PT409',message='Analysis deleted'; end if;
  if a.state='awaiting_upload' then
    if a.input_cleaned_at is not null or a.input_expires_at<=now() then
      raise exception using errcode='PT409',message='Analysis input expired'; end if;
    update public.practice_analyses set state='queued',phase='queued_word_check',input_ready=true where id=p_id;
  end if;
  return public.practice_submission_context(p_owner,p_id);
end $$;

-- Save features, publish coarse output, release fast lease and queue fine atomically.
create function public.publish_acoustic_handoff(p_kind text,p_id uuid,p_token uuid,p_data jsonb) returns boolean
language plpgsql security invoker set search_path='' as $$
declare accepted boolean;
begin
  if p_kind='take' then
    perform 1 from public.practice_analyses where id=p_id and worker_lane='fast' for update;
    if not found then return false; end if;
    accepted=public.update_practice_analysis(p_id,p_token,'checkpoint',p_data);
  elsif p_kind='reference' then
    perform 1 from public.acoustic_references where id=p_id and worker_lane='fast' for update;
    if not found then return false; end if;
    accepted=public.update_acoustic_reference(p_id,p_token,'results',p_data);
  else raise exception 'Invalid acoustic job kind'; end if;
  if not accepted then return false; end if;
  if not public.handoff_acoustic_job(p_kind,p_id,p_token) then
    raise exception 'Atomic handoff failed'; end if;
  return true;
end $$;

revoke all on function public.practice_submission_context(text,uuid),
  public.register_practice_submission(text,jsonb,jsonb),public.finalize_practice_submission(text,uuid),
  public.publish_acoustic_handoff(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.practice_submission_context(text,uuid),
  public.register_practice_submission(text,jsonb,jsonb),public.finalize_practice_submission(text,uuid),
  public.publish_acoustic_handoff(text,uuid,uuid,jsonb) to service_role;
