-- Scoped synthetic rollback-only smoke. Never calls the global queue claim function.
begin;
set local role service_role;
do $$
declare
  owner_name text='libitu-support-smoke-'||gen_random_uuid()::text;
  content_id uuid=gen_random_uuid(); take_id uuid=gen_random_uuid(); lease uuid=gen_random_uuid();
  saved jsonb; initial_check jsonb='{"version":"word-match-v1","status":"reliable","reason":null,"transcript":"We work.","source_tokens":[{"normalized":"we","display":"We","start":0,"end":2},{"normalized":"practice","display":"practice","start":3,"end":11}],"recognized_tokens":[{"normalized":"we","display":"We","start":0,"end":2},{"normalized":"work","display":"work","start":3,"end":7}],"operations":[{"kind":"matched","source_index":0,"recognized_index":0,"source_boundary":null},{"kind":"substituted","source_index":1,"recognized_index":1,"source_boundary":null}],"matched_count":1,"source_count":2,"tier":"below_60"}'::jsonb; ok boolean; n integer;
  metadata jsonb='{"version":"text-support-v1","mode":"hidden","visible_source_indices_at_start":[],"revealed_source_indices":[1]}';
begin
  insert into public.profiles(id) values(owner_name);
  insert into public.contents(id,kind,normalized_key,visibility,title) values(content_id,'pasted_text',owner_name,'public','Synthetic support smoke');
  insert into public.shadow_attempts(id,user_id,content_id,sentence_id,sentence_text,start_ms,end_ms,reference_version,duration_ms,playback_rate,text_visible,request_hash,recording_state,text_support)
    values(take_id,owner_name,content_id,'support-smoke','We practice.',0,2000,'test',2000,1,false,repeat('a',64),'none',metadata);
  insert into public.practice_analyses(id,user_id,request_hash,input_sha256,input_bytes,input_mime,consent_version,analysis_version,snapshot,state,input_ready,phase,lease_token,lease_until)
    values(take_id,owner_name,repeat('b',64),repeat('c',64),100,'audio/ogg','practice-analysis-v1','practice-gated-v3','{}','processing',true,'checking_words',lease,now()+interval '5 minutes');
  select public.update_practice_analysis(take_id,lease,'checkpoint',jsonb_build_object('phase','word_check_complete','word_check',initial_check)) into ok;
  if not ok or (select word_check from public.practice_analyses where id=take_id) is distinct from initial_check then raise exception 'Hosted checkpoint failed'; end if;
  select count(*) into n from public.mark_practice_recognition_error(take_id,'other-owner');
  if n<>0 then raise exception 'Hosted owner bypass'; end if;
  select recognition_feedback into saved from public.mark_practice_recognition_error(take_id,owner_name);
  if saved->>'kind' is distinct from 'recognition_error' then raise exception 'Hosted feedback failed'; end if;
  if (select recognition_feedback from public.mark_practice_recognition_error(take_id,owner_name)) is distinct from saved
    then raise exception 'Hosted feedback not idempotent'; end if;
  if (select word_check from public.practice_analyses where id=take_id) is distinct from initial_check
    or (select phase from public.practice_analyses where id=take_id)<>'word_check_complete' then raise exception 'Hosted feedback changed gate'; end if;
  update public.shadow_attempts set recording_state='deleted' where id=take_id and user_id=owner_name;
  if (select text_support from public.shadow_attempts where id=take_id) is distinct from metadata then raise exception 'Hosted audio-only deletion lost support'; end if;
  begin
    update public.shadow_attempts set text_support=null where id=take_id and user_id=owner_name;
    raise exception 'Mutable snapshot';
  exception when raise_exception then
    if sqlerrm<>'Text support snapshot is immutable' then raise; end if;
  end;
  update public.shadow_attempts set deleted_at=now(),sentence_text='' where id=take_id and user_id=owner_name;
  if exists(select 1 from public.shadow_attempts where id=take_id and (text_support is not null or recognition_feedback is not null))
    or exists(select 1 from public.practice_analyses where id=take_id and (word_check is not null or learner_checkpoint is not null or state<>'deleted'))
    then raise exception 'Hosted deletion did not clear personal data'; end if;
  select public.update_practice_analysis(take_id,lease,'finish','{"state":"completed","result":{}}') into ok;
  if ok then raise exception 'Hosted stale lease resurrected results'; end if;
end $$;
rollback;
select true as scoped_checkpoint_feedback_delete_smoke_passed;

