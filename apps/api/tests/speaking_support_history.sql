-- Read-only projection contract. All synthetic rows roll back.
begin;
set local role service_role;
do $$
declare
  owner_id text := 'history-sql-' || gen_random_uuid()::text;
  foreign_owner text := 'history-other-' || gen_random_uuid()::text;
  corpus_id uuid := gen_random_uuid();
  other_corpus uuid := gen_random_uuid();
  sid uuid;
  iid uuid;
  result jsonb;
  source jsonb;
  projected jsonb;
  before_count bigint;
begin
  assert not has_function_privilege('anon',
    'public.read_speaking_support_history(text,uuid[],integer)','execute');
  assert not has_function_privilege('authenticated',
    'public.read_speaking_support_history(text,uuid[],integer)','execute');
  assert not (select prosecdef from pg_proc where oid =
    'public.read_speaking_support_history(text,uuid[],integer)'::regprocedure);
  insert into public.profiles(id) values (owner_id),(foreign_owner);
  insert into public.corpus_items(id,user_id,kind,text)
    values (corpus_id,owner_id,'chunk','to be fair'),(other_corpus,owner_id,'chunk','unrelated phrase');
  for n in 1..102 loop
    sid := gen_random_uuid();
    iid := gen_random_uuid();
    insert into public.speaking_sessions(id,user_id,client_id,scenario_type,goal,status,request_payload)
      values(sid,case when n=102 then foreign_owner else owner_id end,gen_random_uuid(),
        'workplace','Agree on a date','completed','{}');
    source := jsonb_build_object(
      'session',jsonb_build_object('id',sid,'user_id',case when n=102 then foreign_owner else owner_id end,
        'created_at','2026-10-01T00:00:00Z','evidence_contract_version','speaking-evidence-v3',
        'items',jsonb_build_array(
          jsonb_build_object('id',iid,'source_corpus_item_id',corpus_id,'kind','chunk',
            'text','to be fair','meaning',null,'slots','{}'::jsonb),
          jsonb_build_object('id',gen_random_uuid(),'source_corpus_item_id',other_corpus,
            'text','unrelated private phrase')),
        'mission_plan',jsonb_build_object('setting','Discuss a date','goal','Agree',
          'user_role','Lead','ai_role','Colleague','private','must not leak',
          'targets',jsonb_build_array(jsonb_build_object('session_item_id',iid,'role','primary')))),
      'messages',jsonb_build_array(
        jsonb_build_object('id','user','role','user','revision',1,'status','final',
          'text','to be fair, testing takes time.','finalized_at','2026-10-19T10:00:00Z','private','must not leak'),
        jsonb_build_object('id','unrelated','role','assistant','text','unrelated private words')),
      'evidence','[]'::jsonb,'controller',jsonb_build_object('exposures','[]'::jsonb,'private','must not leak'));
    result := jsonb_build_object('item_results',jsonb_build_array(jsonb_build_object(
      'session_item_id',iid,'role','primary','status','appropriate','opportunity_status','used',
      'independent_uses',1,'private','must not leak',
      'qualifying_independent_evidence',jsonb_build_array(jsonb_build_object(
        'message_id','user','transcript_revision',1,'quote','to be fair','start',0,'end',10)))));
    insert into public.speaking_feedback(session_id,status,source,result,input_hash,rubric_version,analysis_version,created_at)
      values(sid,'ready',source,result,repeat('a',64),'speaking-rubric-v2','speaking-feedback-v3',
        '2026-10-20T00:00:00Z'::timestamptz + n * interval '1 second');
  end loop;
  select count(*) into before_count from public.speaking_feedback;
  projected := public.read_speaking_support_history(owner_id,array[corpus_id]);
  assert projected->'has_more'='true'::jsonb;
  assert jsonb_array_length(projected->'reports')=100;
  assert projected::text not like '%private%';
  assert projected::text not like '%unrelated%';
  assert not (projected->'reports'->0 ? 'practiced_at');
  assert projected->'reports'->0->'items'->0->'messages'->0->>'finalized_at'='2026-10-19T10:00:00Z';
  assert jsonb_array_length(projected->'reports'->0->'items')=1;
  assert projected->'reports'->0->'items'->0->>'target_role'='primary';
  assert projected->'reports'->0->'items'->0->'result'->'qualifying_independent_evidence'->0->>'message_id'='user';
  assert jsonb_array_length(projected->'reports'->0->'items'->0->'messages')=1;
  assert projected->'reports'->0->'items'->0->'skipped'='false'::jsonb;
  assert (select count(*) from public.speaking_feedback)=before_count;
  assert jsonb_array_length(public.read_speaking_support_history(foreign_owner,array[corpus_id])->'reports')=1;
  assert jsonb_array_length(public.read_speaking_support_history(owner_id || '-missing',array[corpus_id])->'reports')=0;
  assert jsonb_array_length(public.read_speaking_support_history(owner_id,array[gen_random_uuid()])->'reports')=0;
  assert jsonb_array_length(public.read_speaking_support_history(owner_id,array[corpus_id],1)->'reports')=1;
  begin
    perform public.read_speaking_support_history(owner_id,array[corpus_id,corpus_id]);
    raise exception 'Expected duplicate input rejection';
  exception when sqlstate 'PT422' then null; end;
  begin
    perform public.read_speaking_support_history(owner_id,array[corpus_id],101);
    raise exception 'Expected bounded limit rejection';
  exception when sqlstate 'PT422' then null; end;
  delete from public.speaking_sessions where user_id=owner_id;
  assert jsonb_array_length(public.read_speaking_support_history(owner_id,array[corpus_id])->'reports')=0;
end;
$$;
rollback;
