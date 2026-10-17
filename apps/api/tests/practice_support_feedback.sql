begin;
insert into public.profiles(id) values('practice-queue-test');
insert into public.contents(id) values('11000000-0000-0000-0000-000000000001');
insert into public.shadow_attempts(id,user_id,content_id,sentence_id,sentence_text,start_ms,end_ms,reference_version,duration_ms,playback_rate,text_visible,request_hash,recording_state)
values('22000000-0000-0000-0000-000000000001','practice-queue-test','11000000-0000-0000-0000-000000000001','s1','We practice.',0,2000,'v1',2000,1,true,repeat('a',64),'none');
insert into public.practice_analyses(id,user_id,request_hash,input_sha256,input_bytes,input_mime,consent_version,analysis_version,snapshot,state,input_ready)
values('22000000-0000-0000-0000-000000000001','practice-queue-test',repeat('b',64),repeat('c',64),100,'audio/ogg','practice-analysis-v1','v1','{}','queued',true);

-- Immutable capture metadata is inserted once, never added to a historical take.
update public.practice_analyses set analysis_version='practice-gated-v3',state='completed',phase='finished',word_check=
  '{"status":"reliable","tier":"below_60","matched_count":1,"source_count":2,"operations":[{"kind":"matched"},{"kind":"substituted"}]}';
insert into public.shadow_attempts(id,user_id,content_id,sentence_id,sentence_text,start_ms,end_ms,reference_version,duration_ms,playback_rate,text_visible,request_hash,recording_state,text_support)
values('22000000-0000-0000-0000-000000000002','practice-queue-test','11000000-0000-0000-0000-000000000001','s2','Hello there.',0,2000,'v1',2000,1,false,repeat('a',64),'none',
  '{"version":"text-support-v1","mode":"hidden","visible_source_indices_at_start":[],"revealed_source_indices":[1]}');
do $$
declare r public.shadow_attempts; saved jsonb; before_check jsonb; n integer;
begin
  select word_check into before_check from public.practice_analyses limit 1;
  select count(*) into n from public.mark_practice_recognition_error('22000000-0000-0000-0000-000000000001','wrong-owner');
  if n<>0 then raise exception 'Feedback owner bypass'; end if;
  select * into r from public.mark_practice_recognition_error('22000000-0000-0000-0000-000000000001','practice-queue-test');
  saved=r.recognition_feedback;
  if saved->>'kind' is distinct from 'recognition_error' then raise exception 'Feedback missing'; end if;
  select * into r from public.mark_practice_recognition_error(r.id,'practice-queue-test');
  if r.recognition_feedback is distinct from saved then raise exception 'Feedback timestamp changed'; end if;
  if (select word_check from public.practice_analyses limit 1) is distinct from before_check
    or (select state from public.practice_analyses limit 1)<>'completed' then raise exception 'Feedback changed analysis'; end if;
  begin
    update public.shadow_attempts set text_support='{"version":"text-support-v1","mode":"full","visible_source_indices_at_start":[0,1],"revealed_source_indices":[]}'
      where id='22000000-0000-0000-0000-000000000002';
    raise exception 'Mutable support accepted';
  exception when raise_exception then
    if sqlerrm<>'Text support snapshot is immutable' then raise; end if;
  end;
  begin
    update public.shadow_attempts set recognition_feedback=null where id=r.id;
    raise exception 'Mutable feedback accepted';
  exception when raise_exception then
    if sqlerrm<>'Recognition feedback is immutable' then raise; end if;
  end;
  -- A missing/reliable-exact check cannot receive initial feedback.
  select count(*) into n from public.mark_practice_recognition_error('22000000-0000-0000-0000-000000000002','practice-queue-test');
  if n<>0 then raise exception 'Missing check accepted'; end if;
  update public.practice_analyses set state='deleted',word_check=null;
  select * into r from public.mark_practice_recognition_error(r.id,'practice-queue-test');
  if r.recognition_feedback is distinct from saved then raise exception 'Existing marker lost with analysis'; end if;
  update public.shadow_attempts set recording_state='deleted' where id='22000000-0000-0000-0000-000000000002';
  if (select text_support from public.shadow_attempts where id='22000000-0000-0000-0000-000000000002') is null
    then raise exception 'Audio-only deletion erased support'; end if;
  update public.shadow_attempts set deleted_at=now(),sentence_text='';
  if exists(select 1 from public.shadow_attempts where recognition_feedback is not null or text_support is not null)
    then raise exception 'Parent deletion retained personal metadata'; end if;
  select count(*) into n from public.mark_practice_recognition_error(r.id,'practice-queue-test');
  if n<>0 then raise exception 'Deleted marker resurrected'; end if;
  if has_function_privilege('anon','public.mark_practice_recognition_error(uuid,text)','execute')
    or has_function_privilege('authenticated','public.mark_practice_recognition_error(uuid,text)','execute')
    or has_function_privilege('anon','public.preserve_practice_support()','execute') then raise exception 'Client feedback grants'; end if;
end $$;
rollback;
