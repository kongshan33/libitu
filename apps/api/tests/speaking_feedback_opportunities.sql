-- Apply after both Mission-plan and feedback-opportunity migrations.
-- All records are synthetic and rolled back.
begin;
set local role service_role;
do $$
declare
  owner_id text := 'feedback-plan-sql-' || gen_random_uuid()::text;
  corpus_id uuid := gen_random_uuid();
  session_doc jsonb;
  v_session_id uuid;
  item_id text;
  runtime_doc jsonb;
  job jsonb;
  saved jsonb;
begin
  assert not has_function_privilege('authenticated',
    'public.enqueue_speaking_feedback(text,uuid,boolean)', 'execute');
  assert not has_table_privilege('anon', 'public.speaking_feedback', 'select');
  insert into public.profiles(id) values (owner_id);
  insert into public.corpus_items(id,user_id,kind,text,tags,source_locator)
    values (corpus_id,owner_id,'chunk','to be fair',array['conceding'],'{}');
  session_doc := public.create_speaking_loadout(owner_id,gen_random_uuid(),'workplace',
    'Agree on the next step','standard','balanced',null,array[corpus_id]);
  v_session_id := (session_doc->>'id')::uuid;
  item_id := session_doc #>> '{items,0,id}';
  runtime_doc := jsonb_build_object(
    'runtime',jsonb_build_object('ticket','PRIVATE_TICKET'),
    'policy',jsonb_build_object('instruction','PRIVATE_INSTRUCTION'),
    'messages',jsonb_build_array(jsonb_build_object(
      'id','user-1','role','user','status','final','ordinal',1,'revision',1,
      'text','To be fair, that is a reasonable request.','input_source','text',
      'created_at','2026-10-20T00:01:00Z','started_at','2026-10-20T00:01:00Z',
      'finalized_at','2026-10-20T00:01:04Z','secret','PRIVATE_MESSAGE')),
    'evidence',jsonb_build_array(jsonb_build_object('id','evidence','session_item_id',item_id,
      'message_id','user-1','transcript_revision',1,'start',0,'end',10,
      'quote','To be fair','match_type','exact','appropriateness','appropriate',
      'prompted',true,'assistance','usage','private','PRIVATE_EVIDENCE')),
    'controller',jsonb_build_object('exposures',jsonb_build_array(jsonb_build_object(
      'id','visible-target','target_item_id',item_id,'after_turn',0,
      'level','usage','scope','session','kind','visual_target','overlap',false,
      'visible_at','2026-10-20T00:00:30Z','secret','PRIVATE_EXPOSURE'))),
    'teaching_attempts',jsonb_build_array(jsonb_build_object(
      'id','attempt','send_status','sent','response_id','response-1',
      'presented',true,'presented_at','2026-10-20T00:00:45Z',
      'policy',jsonb_build_object('target_item_id',item_id,'action','implicit_elicitation',
        'instruction','PRIVATE_ATTEMPT'),
      'assessment',jsonb_build_object('outcome','reflected','exact_quote','What is fair about that?',
        'trace','PRIVATE_ASSESSMENT'))),
    'target_states',jsonb_build_object(item_id,jsonb_build_object(
      'skipped',true,'reason','Not relevant now','version',1,'skipped_at','2026-10-20T00:02:00Z',
      'history',jsonb_build_array(jsonb_build_object(
        'action','skip','at','2026-10-20T00:02:00Z','reason','Not relevant now','secret','PRIVATE_STATE'))))
  );
  insert into public.speaking_runtime_state(session_id,document,version)
    values (v_session_id,runtime_doc,1);
  update public.speaking_sessions set status='completed',turn_count=1 where id=v_session_id;
  job := public.enqueue_speaking_feedback(owner_id,v_session_id,false);
  assert job->>'rubric_version' = 'speaking-rubric-v2';
  assert job->>'analysis_version' = 'speaking-feedback-v3';
  assert job #>> '{source,messages,0,started_at}' = '2026-10-20T00:01:00Z';
  assert job #>> '{source,messages,0,finalized_at}' = '2026-10-20T00:01:04Z';
  assert job #>> '{source,evidence,0,assistance}' = 'usage';
  assert job #>> '{source,controller,exposures,0,scope}' = 'session';
  assert job #>> '{source,controller,exposures,0,visible_at}' = '2026-10-20T00:00:30Z';
  assert job #>> '{source,teaching_attempts,0,assessment,outcome}' = 'reflected';
  assert job #>> '{source,teaching_attempts,0,assessment,exact_quote}' = 'What is fair about that?';
  assert job #>> '{source,teaching_attempts,0,presented}' = 'true';
  assert job #>> array['source','target_states',item_id,'history','0','action'] = 'skip';
  assert (job->'source')::text not like '%PRIVATE_%';
  assert public.read_speaking_feedback(owner_id || '-other',v_session_id) is null;
  saved := job->'source';
  update public.speaking_runtime_state set document='{}' where speaking_runtime_state.session_id=v_session_id;
  job := public.enqueue_speaking_feedback(owner_id,v_session_id,true);
  assert job->'source' = saved;
end;
$$;
rollback;
