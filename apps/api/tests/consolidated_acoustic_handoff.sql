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
update public.practice_analyses set analysis_version='practice-gated-v3',phase='queued_word_check',worker_lane='fast',snapshot='{"progressive_version":"server-prominence-v1"}';
do $$
declare a public.practice_analyses; r public.acoustic_references; ok boolean;
  t uuid='33000000-0000-0000-0000-000000000001';
  u uuid='33000000-0000-0000-0000-000000000002';
begin
  if exists(select 1 from public.claim_practice_analysis_lane(u,30,'fine')) then raise exception 'Fine stole fast'; end if;
  select * into a from public.claim_practice_analysis_lane(t,30,'fast');
  if a.id is null then raise exception 'No fast claim'; end if;
  if exists(select 1 from public.claim_practice_analysis_lane(u,30,'fast')) then raise exception 'Duplicate lease'; end if;
  begin
    perform public.handoff_acoustic_job('take',a.id,t);
    raise exception 'Missing gate accepted';
  exception when raise_exception then
    if sqlerrm<>'Eligible word check required' then raise; end if;
  end;
  perform public.update_practice_analysis(a.id,t,'checkpoint','{"word_check":{"status":"reliable","tier":"full_85_plus"}}');
  begin
    perform public.handoff_acoustic_job('take',a.id,t);
    raise exception 'Missing coarse accepted';
  exception when raise_exception then
    if sqlerrm<>'Coarse checkpoint required' then raise; end if;
  end;
  begin
    perform public.publish_acoustic_handoff('take',a.id,t,'{"acoustic_checkpoint":{"frames":[]},"phase":"analyzing_all"}');
    raise exception 'Incomplete atomic publication accepted';
  exception when raise_exception then
    if sqlerrm<>'Coarse checkpoint required' then raise; end if;
  end;
  if (select acoustic_checkpoint is not null from public.practice_analyses where id=a.id) then
    raise exception 'Failed handoff persisted partial checkpoint'; end if;
  if public.handoff_acoustic_job('take',a.id,u) then raise exception 'Wrong lease handed off'; end if;
  if not public.publish_acoustic_handoff('take',a.id,t,'{"acoustic_checkpoint":{"frames":[]},"coarse_checkpoint":{"prominence":[]},"phase":"coarse_ready"}') then raise exception 'Handoff failed'; end if;
  if public.update_practice_analysis(a.id,t,'finish','{"state":"failed"}') or public.handoff_acoustic_job('take',a.id,t)
    then raise exception 'Old token remained valid'; end if;
  if exists(select 1 from public.claim_practice_analysis_lane(t,30,'fast')) then raise exception 'Fast stole fine'; end if;
  select * into a from public.claim_practice_analysis_lane(u,30,'fine');
  if a.worker_lane<>'fine' or a.coarse_checkpoint is null or a.phase<>'coarse_ready' or a.attempts<>1
    then raise exception 'Lost checkpoint during handoff'; end if;
  -- Crash recovery remains in fine and preserves evidence.
  update public.practice_analyses set lease_until=now()-interval '1 second' where id=a.id;
  select * into a from public.claim_practice_analysis_lane(t,30,'fine');
  if a.id is null or a.attempts<>2 or a.word_check is null then raise exception 'Fine crash recovery'; end if;
  perform public.control_practice_analysis(a.id,a.user_id,'cancel');
  if public.update_practice_analysis(a.id,t,'finish','{"state":"completed"}') then raise exception 'Cancel lost fence'; end if;
  perform public.control_practice_analysis(a.id,a.user_id,'retry');
  if exists(select 1 from public.claim_practice_analysis_lane(u,30,'fast')) then raise exception 'Retry switched lanes'; end if;
  select * into a from public.claim_practice_analysis_lane(u,30,'fine');
  if a.id is null or a.coarse_checkpoint is null then raise exception 'Retry lost evidence'; end if;
  -- The partial gate hands off without any full-frame or coarse checkpoint.
  update public.practice_analyses set worker_lane='fast',word_check='{"status":"reliable","tier":"partial_60_85"}',
    acoustic_checkpoint=null,coarse_checkpoint=null where id=a.id;
  if not public.handoff_acoustic_job('take',a.id,u) then raise exception 'Partial handoff blocked'; end if;
  update public.acoustic_references set state='queued',audio_ready=true,snapshot='{"sentences":[{"id":"s1"}]}';
  if exists(select 1 from public.claim_acoustic_reference_lane(u,30,'fine')) then raise exception 'Fine stole reference fast'; end if;
  select * into r from public.claim_acoustic_reference_lane(t,30,'fast');
  begin
    perform public.handoff_acoustic_job('reference',r.id,t);
    raise exception 'Missing Reference signal accepted';
  exception when raise_exception then
    if sqlerrm<>'Reference signal checkpoint required' then raise; end if;
  end;
  if not public.publish_acoustic_handoff('reference',r.id,t,'{"results":[{"sentence_id":"s1","measurements":{},"coarse":{}}]}') then raise exception 'Reference handoff failed'; end if;
  if public.update_acoustic_reference(r.id,t,'finish','{"state":"completed"}') then raise exception 'Reference stale writer'; end if;
  select * into r from public.claim_acoustic_reference_lane(u,30,'fine');
  if r.id is null or r.attempts<>1 or r.results->0->'coarse' is null then raise exception 'Reference fine lost signal'; end if;
  perform public.control_acoustic_reference(r.id,r.user_id,'delete');
  if public.update_acoustic_reference(r.id,u,'results','{"results":[]}') then raise exception 'Deleted reference write'; end if;
  if has_function_privilege('anon','public.handoff_acoustic_job(text,uuid,uuid)','execute')
    or has_function_privilege('authenticated','public.claim_acoustic_reference_lane(uuid,integer,text)','execute')
    then raise exception 'Public lane RPC'; end if;
end $$;
rollback;
