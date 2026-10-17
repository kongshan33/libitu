-- Isolated synthetic records. No audio, analysis jobs or global queue operations.
begin;
set local role service_role;
do $$
<<smoke>>
declare
  owner_name text='libitu-directory-smoke-'||gen_random_uuid()::text;
  other_owner text=owner_name||'-other';
  content_id uuid=gen_random_uuid(); other_content uuid=gen_random_uuid();
  progress jsonb;
begin
  insert into public.profiles(id) values(owner_name),(other_owner);
  insert into public.contents(id,kind,normalized_key,visibility,title)
    values(content_id,'pasted_text',owner_name,'public','Synthetic directory smoke'),
      (other_content,'pasted_text',other_owner,'public','Synthetic directory smoke');
  insert into public.shadow_attempts(id,user_id,content_id,sentence_id,sentence_text,start_ms,end_ms,reference_version,duration_ms,playback_rate,text_visible,request_hash,recording_state)
    select gen_random_uuid(),owner_name,content_id,'sentence-'||n,'Test words.',0,2000,'test',2000,1,false,repeat('a',64),'none'
      from generate_series(1,1100) n;
  -- Repeated takes and audio-only deletions still establish a single practiced sentence.
  insert into public.shadow_attempts(id,user_id,content_id,sentence_id,sentence_text,start_ms,end_ms,reference_version,duration_ms,playback_rate,text_visible,request_hash,recording_state)
    values(gen_random_uuid(),owner_name,content_id,'sentence-1','Test words.',0,2000,'test',2000,1,false,repeat('b',64),'deleted'),
      (gen_random_uuid(),other_owner,content_id,'other-owner','Test words.',0,2000,'test',2000,1,false,repeat('b',64),'none'),
      (gen_random_uuid(),owner_name,other_content,'other-content','Test words.',0,2000,'test',2000,1,false,repeat('b',64),'none');
  progress=public.practice_directory_progress(owner_name,content_id);
  if jsonb_array_length(progress)<>1100 or progress ? 'other-owner' or progress ? 'other-content'
    then raise exception 'Incomplete or unscoped directory'; end if;
  update public.shadow_attempts a set deleted_at=now(),sentence_text='' where a.user_id=owner_name and a.content_id=smoke.content_id
    and a.sentence_id='sentence-2';
  progress=public.practice_directory_progress(owner_name,content_id);
  if jsonb_array_length(progress)<>1099 or progress ? 'sentence-2' or not progress ? 'sentence-1'
    then raise exception 'Wrong surviving-record progress'; end if;
  if public.practice_directory_progress(owner_name,gen_random_uuid())<>'[]'::jsonb
    then raise exception 'Empty progress is not empty'; end if;
  if has_function_privilege('anon','public.practice_directory_progress(text,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.practice_directory_progress(text,uuid)','EXECUTE')
    then raise exception 'Client progress access'; end if;
end $$;
rollback;
select true as directory_progress_smoke_passed;
