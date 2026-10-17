-- Disposable migrated database only; every fixture is rolled back.
begin;
insert into public.contents(id,kind,normalized_key,visibility)
values('11000000-0000-0000-0000-000000000099','pasted_text','submit-fixture','public');
do $$
declare owner text='submit-fixture'; take_id uuid='22000000-0000-0000-0000-000000000099';
  attempt jsonb; analysis jsonb; ctx jsonb;
begin
  attempt=jsonb_build_object('id',take_id,'user_id',owner,'content_id','11000000-0000-0000-0000-000000000099',
    'sentence_id','s1','sentence_text','We practice every day.','start_ms',0,'end_ms',2000,'reference_version','v1',
    'duration_ms',2000,'playback_rate',1,'text_visible',true,'request_hash',repeat('a',64),'recording_state','none');
  analysis=jsonb_build_object('id',take_id,'user_id',owner,'request_hash',repeat('b',64),'input_sha256',repeat('c',64),
    'input_bytes',100,'input_mime','audio/ogg','consent_version','practice-analysis-v1','analysis_version','practice-gated-v3','snapshot','{}'::jsonb);
  ctx=public.register_practice_submission(owner,attempt,analysis);
  if ctx->'analysis'->>'state'<>'awaiting_upload' or ctx->'attempt'->>'recording_state'<>'none'
    then raise exception 'Registration state'; end if;
  if public.practice_submission_context('other',take_id) is not null then raise exception 'Owner leak'; end if;
  begin
    perform public.register_practice_submission(owner,attempt,jsonb_set(analysis,'{request_hash}',to_jsonb(repeat('d',64))));
    raise exception 'Identity conflict accepted';
  exception when sqlstate 'PT409' then null; end;
  ctx=public.finalize_practice_submission(owner,take_id);
  if ctx->'analysis'->>'state'<>'queued' or ctx->'analysis'->>'input_ready'<>'true' then raise exception 'Queue'; end if;
  update public.practice_analyses set state='completed',input_cleaned_at=now(),coarse_checkpoint='{"private":true}' where practice_analyses.id=take_id;
  ctx=public.register_practice_submission(owner,attempt,analysis);
  ctx=public.finalize_practice_submission(owner,take_id);
  if ctx->'analysis'->>'state'<>'completed' or ctx->'analysis' ? 'coarse_checkpoint' then raise exception 'Replay reset or private leakage'; end if;
  update public.shadow_attempts set deleted_at=now() where shadow_attempts.id=take_id;
  begin
    perform public.finalize_practice_submission(owner,take_id);raise exception 'Deleted revived';
  exception when sqlstate 'PT409' then null; end;
  begin
    perform public.register_practice_submission(owner,attempt,analysis);raise exception 'Deleted registered';
  exception when sqlstate 'PT409' then null; end;
  if has_function_privilege('anon','public.register_practice_submission(text,jsonb,jsonb)','execute')
    or has_function_privilege('authenticated','public.publish_acoustic_handoff(text,uuid,uuid,jsonb)','execute')
    then raise exception 'Public mutation'; end if;
end $$;
rollback;
