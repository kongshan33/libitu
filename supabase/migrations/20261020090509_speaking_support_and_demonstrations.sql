-- Optional initial scaffolding preserves historical sessions and retry identities.
alter table public.speaking_sessions add column support_level text,
  add constraint speaking_sessions_support_level_check
  check (support_level is null or support_level in ('model_frame','model_label','label_only','no_hint'));

create or replace function public.get_speaking_loadout(p_user_id text, p_session_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id, 'user_id', s.user_id, 'client_id', s.client_id,
    'scenario_type', s.scenario_type, 'goal', s.goal, 'difficulty', s.difficulty,
    'feedback_level', s.feedback_level, 'logic_template', s.logic_template,
    'status', s.status, 'created_at', s.created_at, 'turn_count', s.turn_count,
    'mission_plan', s.mission_plan, 'support_level', s.support_level,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'corpus_item_id', i.corpus_item_id, 'ordinal', i.ordinal,
        'kind', i.kind, 'text', i.text_snapshot, 'meaning', i.meaning_snapshot,
        'tags', i.tags_snapshot, 'slots', i.slots_snapshot, 'source_title', i.source_title_snapshot,
        'usage_note', i.usage_note_snapshot, 'register', i.register_snapshot,
        'scenario_tags', i.scenario_tags_snapshot, 'pattern_family', i.pattern_family_snapshot
      ) order by i.ordinal) from public.speaking_session_items i where i.session_id = s.id
    ), '[]'::jsonb)
  ) from public.speaking_sessions s
  where s.id = p_session_id and s.user_id = p_user_id and s.client_id is not null;
$$;

-- A separate RPC preserves both existing signatures and absent-field retry payloads.
create function public.create_supported_speaking_loadout(
  p_user_id text, p_client_id uuid, p_scenario_type text, p_goal text,
  p_difficulty text, p_feedback_level text, p_logic_template jsonb,
  p_corpus_item_ids uuid[], p_support_level text,
  p_plan_id uuid default null, p_candidate_id uuid default null
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_request jsonb;
  v_existing public.speaking_sessions%rowtype;
  v_created jsonb;
  v_session_id uuid;
begin
  if p_user_id is null or length(btrim(p_user_id)) = 0 or p_client_id is null
    or p_support_level is null
    or p_support_level not in ('model_frame','model_label','label_only','no_hint')
    or (p_plan_id is null) <> (p_candidate_id is null) then
    raise sqlstate 'PT422' using message = 'Invalid speaking support setup.';
  end if;
  v_request := jsonb_build_object(
    'scenario_type',p_scenario_type,'goal',btrim(p_goal),'difficulty',p_difficulty,
    'feedback_level',p_feedback_level,'logic_template_id',p_logic_template->>'id',
    'corpus_item_ids',to_jsonb(p_corpus_item_ids),'support_level',p_support_level);
  if p_plan_id is not null then
    v_request := v_request || jsonb_build_object('plan_id',p_plan_id,'candidate_id',p_candidate_id);
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_client_id::text, 0));
  select * into v_existing from public.speaking_sessions
    where user_id = p_user_id and client_id = p_client_id;
  -- Recovery precedes source lookup, just as in both existing creation paths.
  if found then
    if v_existing.request_payload is distinct from v_request then
      raise sqlstate 'PT409' using message = 'Submission already used for a different loadout.';
    end if;
    return public.get_speaking_loadout(p_user_id,v_existing.id);
  end if;
  if p_plan_id is null then
    v_created := public.create_speaking_loadout(p_user_id,p_client_id,p_scenario_type,p_goal,
      p_difficulty,p_feedback_level,p_logic_template,p_corpus_item_ids);
  else
    v_created := public.create_planned_speaking_loadout(p_user_id,p_client_id,p_scenario_type,p_goal,
      p_difficulty,p_feedback_level,p_logic_template,p_corpus_item_ids,p_plan_id,p_candidate_id);
  end if;
  v_session_id := (v_created->>'id')::uuid;
  update public.speaking_sessions set support_level = p_support_level, request_payload = v_request
    where id = v_session_id and user_id = p_user_id;
  return public.get_speaking_loadout(p_user_id,v_session_id);
end;
$$;
revoke all on function public.create_supported_speaking_loadout(text,uuid,text,text,text,text,jsonb,uuid[],text,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.create_supported_speaking_loadout(text,uuid,text,text,text,text,jsonb,uuid[],text,uuid,uuid)
  to service_role;

-- Freeze actual teaching presentation, plan opportunity evidence and exclusions.
-- Existing reports retain their immutable input, result and rubric versions.
create or replace function public.enqueue_speaking_feedback(p_user_id text, p_session_id uuid, p_retry boolean default false)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_session public.speaking_sessions%rowtype;
  v_job public.speaking_feedback%rowtype;
  v_document jsonb;
  v_source jsonb;
begin
  if p_user_id is null or length(btrim(p_user_id)) = 0 or p_session_id is null or p_retry is null then
    raise sqlstate 'PT422' using message = 'Invalid speaking feedback state.';
  end if;
  -- Runtime CAS, enqueue, complete and deletion serialize on this same parent.
  select * into v_session from public.speaking_sessions
    where id = p_session_id and user_id = p_user_id and client_id is not null for update;
  if not found then return null; end if;
  if v_session.status <> 'completed' then
    raise sqlstate 'PT409' using message = 'End this session before requesting feedback.';
  end if;
  select * into v_job from public.speaking_feedback where session_id = p_session_id for update;
  if found then
    if v_job.source is null then
      raise sqlstate 'PT422' using message = 'Legacy feedback cannot be reprocessed.';
    end if;
    if p_retry and v_job.status in ('partial','failed') and v_job.attempts < 3
      and coalesce(v_job.error_code,'') not in ('input_limit','worker_version_mismatch') then
      update public.speaking_feedback set status = 'queued', error_code = null,
        lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
        where id = v_job.id;
    end if;
    return public.read_speaking_feedback(p_user_id, p_session_id);
  end if;
  select document into v_document from public.speaking_runtime_state where session_id = p_session_id;
  v_document := coalesce(v_document, '{}'::jsonb);
  -- Do not copy the private runtime, authentication ticket or provider instructions.
  v_source := jsonb_build_object(
    'session', public.get_speaking_loadout(p_user_id, p_session_id),
    'messages', coalesce((select jsonb_agg((select coalesce(jsonb_object_agg(key,value), '{}'::jsonb)
      from jsonb_each(row) where key = any(array['id','ordinal','role','text','input_source','status',
        'revision','provider_item_id','response_id','client_turn_id','created_at','started_at','finalized_at'])) order by ord)
      from jsonb_array_elements(coalesce(v_document->'messages','[]'::jsonb)) with ordinality as m(row,ord)
      where jsonb_typeof(row) = 'object'), '[]'::jsonb),
    'evidence', coalesce((select jsonb_agg((select coalesce(jsonb_object_agg(key,value), '{}'::jsonb)
      from jsonb_each(row) where key = any(array['id','session_item_id','message_id','transcript_revision',
        'start','end','quote','match_type','appropriateness','prompted','assistance','reason'])) order by ord)
      from jsonb_array_elements(coalesce(v_document->'evidence','[]'::jsonb)) with ordinality as e(row,ord)
      where jsonb_typeof(row) = 'object'), '[]'::jsonb),
    'controller', jsonb_build_object('exposures', coalesce((select jsonb_agg((select
      coalesce(jsonb_object_agg(key,value), '{}'::jsonb) from jsonb_each(row)
      where key = any(array['id','target_item_id','source_message_id','source_revision','after_turn','kind','level','visible_at','overlap','response_id','scope','certainty'])) order by ord)
      from jsonb_array_elements(coalesce(v_document->'controller'->'exposures','[]'::jsonb))
        with ordinality as x(row,ord) where jsonb_typeof(row) = 'object'), '[]'::jsonb)),
    'teaching_attempts', coalesce((select jsonb_agg(
      (select coalesce(jsonb_object_agg(key,value), '{}'::jsonb) from jsonb_each(row)
        where key = any(array['id','response_id','sent_at','bound_at','send_status','presented','presented_at']))
      || jsonb_build_object(
        'policy', (select coalesce(jsonb_object_agg(key,value), '{}'::jsonb)
          from jsonb_each(coalesce(row->'policy','{}'::jsonb)) where key = any(array['target_item_id','action','support_level','support_version'])),
        'assessment', (select coalesce(jsonb_object_agg(key,value), '{}'::jsonb)
          from jsonb_each(coalesce(row->'assessment','{}'::jsonb)) where key = any(array['outcome','reason','exact_quote','model_quote','transfer_question_quote']))
      ) order by ord)
      from jsonb_array_elements(coalesce(v_document->'teaching_attempts','[]'::jsonb))
        with ordinality as a(row,ord) where jsonb_typeof(row) = 'object'), '[]'::jsonb),
    'target_states', coalesce((select jsonb_object_agg(target.key,
      (select coalesce(jsonb_object_agg(key,value), '{}'::jsonb) from jsonb_each(target.value)
        where key = any(array['skipped','reason','skipped_at','restored_at','version']))
      || jsonb_build_object('history', coalesce((select jsonb_agg(
        (select coalesce(jsonb_object_agg(key,value), '{}'::jsonb) from jsonb_each(event)
          where key = any(array['action','at','reason'])) order by ord)
        from jsonb_array_elements(coalesce(target.value->'history','[]'::jsonb))
          with ordinality as h(event,ord) where jsonb_typeof(event) = 'object'), '[]'::jsonb)))
      from jsonb_each(coalesce(v_document->'target_states','{}'::jsonb)) as target
      where jsonb_typeof(target.value) = 'object'), '{}'::jsonb)
  );
  if jsonb_typeof(v_document->'support') = 'object' then
    v_source := v_source || jsonb_build_object('support',
      (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
        from jsonb_each(v_document->'support') where key = any(array['level','version'])));
  end if;
  if jsonb_typeof(v_document->'support_history') = 'array' then
    v_source := v_source || jsonb_build_object('support_history',coalesce((select jsonb_agg(
      (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(event)
        where key = any(array['level','version','at'])) order by ord)
      from jsonb_array_elements(v_document->'support_history') with ordinality as h(event,ord)
      where jsonb_typeof(event) = 'object'),'[]'::jsonb));
  end if;
  if octet_length(v_source::text) > 2097152 then
    raise sqlstate 'PT422' using message = 'Invalid speaking feedback state.';
  end if;
  insert into public.speaking_feedback(session_id,status,source,input_hash,rubric_version,analysis_version)
    values (p_session_id,'queued',v_source,encode(sha256(convert_to(v_source::text, 'UTF8')),'hex'),
      'speaking-rubric-v2','speaking-feedback-v2');
  return public.read_speaking_feedback(p_user_id, p_session_id);
end;
$$;

revoke all on function public.enqueue_speaking_feedback(text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.enqueue_speaking_feedback(text,uuid,boolean) to service_role;
