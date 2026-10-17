-- Run only on a disposable migrated database. Transaction rolls back all fixtures.
begin;
insert into public.profiles(id) values('practice-queue-test');
insert into public.contents(id,kind,normalized_key) values('11000000-0000-0000-0000-000000000001','pasted_text','practice-queue-test');
insert into public.shadow_attempts(id,user_id,content_id,sentence_id,sentence_text,start_ms,end_ms,reference_version,duration_ms,playback_rate,text_visible,request_hash,recording_state)
values('22000000-0000-0000-0000-000000000001','practice-queue-test','11000000-0000-0000-0000-000000000001','s1','We practice.',0,2000,'v1',2000,1,true,repeat('a',64),'none');
insert into public.practice_analyses(id,user_id,request_hash,input_sha256,input_bytes,input_mime,consent_version,analysis_version,snapshot,state,input_ready)
values('22000000-0000-0000-0000-000000000001','practice-queue-test',repeat('b',64),repeat('c',64),100,'audio/ogg','practice-analysis-v1','v1','{}','queued',true);
insert into public.acoustic_references(id,user_id,content_id,segment_id,source_id,source_fingerprint,input_mode,input_sha256,analysis_version,snapshot,start_ms,end_ms,state,expires_at)
values('44000000-0000-0000-0000-000000000001','practice-queue-test','11000000-0000-0000-0000-000000000001','seg','browser_capture',repeat('d',64),'upload',repeat('e',64),'v1','{}',0,2000,'awaiting_upload',now()+interval '1 day');
update public.practice_analyses set reference_id='44000000-0000-0000-0000-000000000001';
update public.practice_analyses set analysis_version='practice-gated-v3',phase='queued_word_check';
do $$
declare r public.practice_analyses; n integer; ok boolean; saved jsonb;
begin
  select * into r from public.claim_practice_analysis_lane('33000000-0000-0000-0000-000000000001',30,'fine');
  if r.state is distinct from 'processing' or r.attempts<>1 then raise exception 'Word check blocked by pending reference'; end if;
  saved='{"version":"word-match-v1","status":"reliable","tier":"full_85_plus","matched_count":2,"source_count":2}'::jsonb;
  select public.update_practice_analysis(r.id,'33000000-0000-0000-0000-000000000001','checkpoint',
    jsonb_build_object('phase','word_check_complete','word_check',saved)) into ok;
  if not ok or (select word_check from public.practice_analyses where id=r.id) is distinct from saved
    or (select attempts from public.practice_analyses where id=r.id)<>0 then raise exception 'Durable checkpoint'; end if;
  select public.update_practice_analysis(r.id,'33000000-0000-0000-0000-000000000002','checkpoint',
    '{"phase":"analyzing_all"}') into ok;
  if ok then raise exception 'Stale checkpoint accepted'; end if;
  -- Crash after ASR: reclaim even though Reference is still pending.
  update public.practice_analyses set lease_until=now()-interval '1 second' where id=r.id;
  select * into r from public.claim_practice_analysis_lane('33000000-0000-0000-0000-000000000001',30,'fine');
  if r.id is null or r.word_check is distinct from saved or r.learner_checkpoint is not null
    then raise exception 'Pending Reference blocks learner acoustics recovery'; end if;
  perform public.update_practice_analysis(r.id,'33000000-0000-0000-0000-000000000001','checkpoint',
    '{"phase":"analyzing_all","learner_checkpoint":{"words":[]}}');
  perform public.update_practice_analysis(r.id,'33000000-0000-0000-0000-000000000001','wait_reference');
  update public.practice_analyses set available_at=now() where id=r.id;
  for i in 1..5 loop
    select count(*) into n from public.claim_practice_analysis_lane('33000000-0000-0000-0000-000000000002',30,'fine');
    if n<>0 or (select attempts from public.practice_analyses where id=r.id)<>0 then raise exception 'Waiting consumes attempts'; end if;
  end loop;
  update public.acoustic_references set state='failed';
  update public.practice_analyses set available_at=now();
  select * into r from public.claim_practice_analysis_lane('33000000-0000-0000-0000-000000000002',30,'fine');
  if r.word_check is distinct from saved or r.attempts<>1 then raise exception 'Checkpoint resume'; end if;
  perform public.update_practice_analysis(r.id,'33000000-0000-0000-0000-000000000002','checkpoint',
    '{"phase":"analyzing_all","learner_checkpoint":{"words":[]}}');
  perform public.control_practice_analysis(r.id,'wrong-owner','cancel');
  if (select state from public.practice_analyses where id=r.id)<>'processing' then raise exception 'Owner isolation'; end if;
  perform public.control_practice_analysis(r.id,'practice-queue-test','cancel');
  select public.update_practice_analysis(r.id,'33000000-0000-0000-0000-000000000002','checkpoint',
    '{"phase":"analyzing_all"}') into ok;
  if ok then raise exception 'Cancelled checkpoint'; end if;
  perform public.control_practice_analysis(r.id,'practice-queue-test','retry');
  select * into r from public.claim_practice_analysis_lane('33000000-0000-0000-0000-000000000003',30,'fine');
  if r.word_check is distinct from saved or r.learner_checkpoint is null then raise exception 'Lost retry checkpoint'; end if;
  update public.shadow_attempts set deleted_at=now(),sentence_text='' where id=r.id;
  select public.update_practice_analysis(r.id,'33000000-0000-0000-0000-000000000003','finish','{"state":"completed","result":{}}') into ok;
  if ok or exists(select 1 from public.practice_analyses where id=r.id and (word_check is not null or learner_checkpoint is not null))
    then raise exception 'Deleted check resurrection'; end if;
  if has_table_privilege('anon','public.practice_analyses','select') or has_table_privilege('authenticated','public.practice_analyses','select')
    or has_function_privilege('anon','public.update_practice_analysis(uuid,uuid,text,jsonb)','execute')
    or has_function_privilege('authenticated','public.control_practice_analysis(uuid,text,text)','execute')
    or has_function_privilege('anon','public.claim_practice_analysis_lane(uuid,integer,text)','execute') then raise exception 'Client privileges'; end if;
end $$;
rollback;
