-- Disposable migrated PostgreSQL; all fixtures rolled back.
begin;
insert into public.profiles(id) values('read-owner'),('read-other');
insert into public.contents(id,kind,normalized_key,visibility,owner_user_id)
values('11000000-0000-0000-0000-000000000077','pasted_text','read-fixture','public',null);
insert into public.shadow_attempts(id,user_id,content_id,sentence_id,sentence_text,start_ms,end_ms,reference_version,duration_ms,playback_rate,text_visible,request_hash,recording_state)
values('22000000-0000-0000-0000-000000000077','read-owner','11000000-0000-0000-0000-000000000077','s1','We practice.',0,2000,'v1',2000,1,true,repeat('a',64),'none');
do $$
declare ctx jsonb; take_id uuid='22000000-0000-0000-0000-000000000077';
begin
 ctx=public.practice_analysis_read_snapshot('read-owner',take_id);
 if ctx->'analysis'<>'null'::jsonb then raise exception 'Missing job must be null'; end if;
 if public.practice_analysis_read_snapshot('read-other',take_id) is not null then raise exception 'Owner leak'; end if;
end $$;
insert into public.acoustic_references(id,user_id,content_id,segment_id,source_id,source_fingerprint,input_mode,input_sha256,analysis_version,snapshot,start_ms,end_ms,state,expires_at,results)
values('44000000-0000-0000-0000-000000000077','read-owner','11000000-0000-0000-0000-000000000077','seg','browser_capture',repeat('d',64),'upload',repeat('e',64),'v1',
'{"source_kind":"browser_capture","consent_version":"reference-analysis-v1","sentences":[{"id":"s1","text":"We practice.","start_ms":0,"end_ms":2000},{"id":"other","text":"hidden"}]}',
0,2000,'completed',now()+interval '1 day',
'[{"sentence_id":"s1","coarse":{},"measurements":{"frames":["PRIVATE"]},"prosody":{"words":["PRIVATE"]}},{"sentence_id":"other","coarse":{"hidden":true}}]');
insert into public.practice_analyses(id,user_id,reference_id,request_hash,input_sha256,input_bytes,input_mime,consent_version,analysis_version,snapshot,state,input_ready,acoustic_checkpoint,learner_checkpoint,coarse_checkpoint)
values('22000000-0000-0000-0000-000000000077','read-owner','44000000-0000-0000-0000-000000000077',repeat('b',64),repeat('c',64),100,'audio/ogg','practice-analysis-v1','practice-gated-v3','{"engine":{}}','processing',true,'{"private":true}','{"private":true}','{}');
do $$
declare ctx jsonb; take_id uuid='22000000-0000-0000-0000-000000000077';
  ref_id uuid='44000000-0000-0000-0000-000000000077';
begin
 ctx=public.practice_analysis_read_snapshot('read-owner',take_id);
 if ctx->'reference'->>'id' is distinct from ref_id::text then raise exception 'Reference missing'; end if;
 if ctx->'analysis' ? 'acoustic_checkpoint' or ctx->'analysis' ? 'learner_checkpoint'
   or ctx::text like '%PRIVATE%' or ctx::text like '%hidden%' then raise exception 'Private checkpoints leaked'; end if;
 if jsonb_array_length(ctx->'reference'->'results')<>1
   or jsonb_array_length(ctx->'reference'->'snapshot'->'sentences')<>1 then raise exception 'Wrong sentence projection'; end if;
 update public.contents set visibility='private',owner_user_id='read-other';
 ctx=public.practice_analysis_read_snapshot('read-owner',take_id);
 if ctx->'reference'<>'null'::jsonb or ctx->'analysis'='null'::jsonb then raise exception 'Source visibility'; end if;
 update public.contents set owner_user_id='read-owner';
 if public.practice_analysis_read_snapshot('read-owner',take_id)->'reference'='null'::jsonb then raise exception 'Owner source denied'; end if;
 update public.acoustic_references set user_id='read-other' where id=ref_id;
 if public.practice_analysis_read_snapshot('read-owner',take_id)->'reference'<>'null'::jsonb then raise exception 'Reference owner'; end if;
 update public.acoustic_references set user_id='read-owner',expires_at=now()-interval '1 second' where id=ref_id;
 if public.practice_analysis_read_snapshot('read-owner',take_id)->'reference'<>'null'::jsonb then raise exception 'Reference expiry'; end if;
 update public.acoustic_references set expires_at=now()+interval '1 day',state='deleted' where id=ref_id;
 if public.practice_analysis_read_snapshot('read-owner',take_id)->'reference'<>'null'::jsonb then raise exception 'Reference deletion'; end if;
 update public.acoustic_references set state='completed' where id=ref_id;
 update public.practice_analyses set coarse_checkpoint=null where id=take_id;
 if public.practice_analysis_read_snapshot('read-owner',take_id)->'reference'<>'null'::jsonb then raise exception 'Unneeded Reference fetched'; end if;
 update public.practice_analyses set state='deleted',snapshot='{}',coarse_checkpoint=null where id=take_id;
 if public.practice_analysis_read_snapshot('read-owner',take_id)->'analysis'->>'state'<>'deleted' then raise exception 'Job tombstone'; end if;
 update public.shadow_attempts set deleted_at=now() where id=take_id;
 if public.practice_analysis_read_snapshot('read-owner',take_id) is not null then raise exception 'Parent deletion'; end if;
 if has_function_privilege('anon','public.practice_analysis_read_snapshot(text,uuid)','execute')
   or has_function_privilege('authenticated','public.practice_analysis_read_snapshot(text,uuid)','execute')
   or not has_function_privilege('service_role','public.practice_analysis_read_snapshot(text,uuid)','execute')
   then raise exception 'RPC privilege'; end if;
end $$;
rollback;
