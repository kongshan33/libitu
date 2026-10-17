begin;
insert into public.profiles(id) values('practice-queue-test');
insert into public.contents(id,kind,normalized_key) values('11000000-0000-0000-0000-000000000001','pasted_text','queue-fixture');
insert into public.shadow_attempts(id,user_id,content_id,sentence_id,sentence_text,start_ms,end_ms,reference_version,duration_ms,playback_rate,text_visible,request_hash,recording_state)
values('22000000-0000-0000-0000-000000000001','practice-queue-test','11000000-0000-0000-0000-000000000001','s1','We practice.',0,2000,'v1',2000,1,true,repeat('a',64),'none');
insert into public.practice_analyses(id,user_id,request_hash,input_sha256,input_bytes,input_mime,consent_version,analysis_version,snapshot,state,input_ready)
values('22000000-0000-0000-0000-000000000001','practice-queue-test',repeat('b',64),repeat('c',64),100,'audio/ogg','practice-analysis-v1','v1','{}','queued',true);
insert into public.acoustic_references(id,user_id,content_id,segment_id,source_id,source_fingerprint,input_mode,input_sha256,analysis_version,snapshot,start_ms,end_ms,state,expires_at)
values('44000000-0000-0000-0000-000000000001','practice-queue-test','11000000-0000-0000-0000-000000000001','seg','browser_capture',repeat('d',64),'upload',repeat('e',64),'v1','{}',0,2000,'awaiting_upload',now()+interval '1 day');
update public.practice_analyses set reference_id='44000000-0000-0000-0000-000000000001';
do $$
declare r public.practice_analyses; n integer; ok boolean;
begin
  for i in 1..5 loop
    select count(*) into n from public.claim_practice_analysis_lane('33000000-0000-0000-0000-000000000001',30,'fine');
    if n<>0 or (select attempts from public.practice_analyses limit 1)<>0 then raise exception 'Waiting reference consumed learner attempts'; end if;
  end loop;
  update public.acoustic_references set state='failed';
  select * into r from public.claim_practice_analysis_lane('33000000-0000-0000-0000-000000000001',30,'fine');
  if r.state is distinct from 'processing' or r.attempts<>1 then raise exception 'claim'; end if;
  select count(*) into n from public.claim_practice_analysis_lane('33000000-0000-0000-0000-000000000002',30,'fine');
  if n<>0 then raise exception 'double claim'; end if;
  update public.practice_analyses set lease_until=now()-interval '1 second' where id=r.id;
  perform public.claim_practice_analysis_lane('33000000-0000-0000-0000-000000000002',30,'fine');
  select public.update_practice_analysis(r.id,'33000000-0000-0000-0000-000000000001','finish','{"state":"completed","result":{"old":true}}') into ok;
  if ok then raise exception 'stale worker'; end if;
  perform public.control_practice_analysis(r.id,'wrong-owner','delete');
  if (select state from public.practice_analyses where id=r.id)<>'processing' then raise exception 'owner bypass'; end if;
  perform public.control_practice_analysis(r.id,'practice-queue-test','cancel');
  select public.update_practice_analysis(r.id,'33000000-0000-0000-0000-000000000002','finish','{"state":"completed"}') into ok;
  if ok then raise exception 'cancel race'; end if;
  perform public.control_practice_analysis(r.id,'practice-queue-test','retry');
  select * into r from public.claim_practice_analysis_lane('33000000-0000-0000-0000-000000000003',30,'fine');
  if r.attempts<>1 then raise exception 'retry'; end if;
  update public.shadow_attempts set deleted_at=now(),sentence_text='' where id=r.id;
  select public.update_practice_analysis(r.id,'33000000-0000-0000-0000-000000000003','finish','{"state":"completed","result":{"late":true}}') into ok;
  if ok or (select state from public.practice_analyses where id=r.id)<>'deleted'
    or (select result from public.practice_analyses where id=r.id) is not null then raise exception 'deletion resurrection'; end if;
  if has_table_privilege('anon','public.practice_analyses','select') or has_table_privilege('authenticated','public.practice_analyses','insert')
    or has_function_privilege('anon','public.claim_practice_analysis_lane(uuid,integer,text)','execute') then raise exception 'client grants'; end if;
end $$;
rollback;
