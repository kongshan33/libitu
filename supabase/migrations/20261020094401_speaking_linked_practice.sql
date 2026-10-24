-- Linked practice and evidence identity are new facts, never inferred for old rows.
alter table public.speaking_session_items add column source_corpus_item_id uuid;
alter table public.speaking_sessions
  add column evidence_contract_version text,
  add column practice jsonb,
  add column practice_parent_session_id uuid references public.speaking_sessions(id) on delete set null,
  add constraint speaking_sessions_evidence_contract_check
    check (evidence_contract_version is null or evidence_contract_version = 'speaking-evidence-v3'),
  add constraint speaking_sessions_practice_object
    check (practice is null or jsonb_typeof(practice) = 'object');
create index speaking_sessions_practice_parent_idx
  on public.speaking_sessions(practice_parent_session_id) where practice_parent_session_id is not null;

create or replace function public.get_speaking_loadout(p_user_id text, p_session_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id, 'user_id', s.user_id, 'client_id', s.client_id,
    'scenario_type', s.scenario_type, 'goal', s.goal, 'difficulty', s.difficulty,
    'feedback_level', s.feedback_level, 'logic_template', s.logic_template,
    'status', s.status, 'created_at', s.created_at, 'turn_count', s.turn_count,
    'mission_plan', s.mission_plan, 'support_level', s.support_level,
    'evidence_contract_version', s.evidence_contract_version,
    'practice', case when s.practice is null then null else
      s.practice || jsonb_build_object('parent_session_id', s.practice_parent_session_id) end,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'corpus_item_id', i.corpus_item_id,
        'source_corpus_item_id', i.source_corpus_item_id, 'ordinal', i.ordinal,
        'kind', i.kind, 'text', i.text_snapshot, 'meaning', i.meaning_snapshot,
        'tags', i.tags_snapshot, 'slots', i.slots_snapshot, 'source_title', i.source_title_snapshot,
        'usage_note', i.usage_note_snapshot, 'register', i.register_snapshot,
        'scenario_tags', i.scenario_tags_snapshot, 'pattern_family', i.pattern_family_snapshot
      ) order by i.ordinal) from public.speaking_session_items i where i.session_id = s.id
    ), '[]'::jsonb)
  ) from public.speaking_sessions s
  where s.id = p_session_id and s.user_id = p_user_id and s.client_id is not null;
$$;

-- Called only by server RPCs. Lock the owned parent while checking its immutable
-- language and linkage; mutable tags/register are not language identity.
create function public.validate_speaking_practice(
  p_user_id text, p_plan jsonb, p_snapshots jsonb
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_source jsonb := p_plan->'practice_source';
  v_parent public.speaking_sessions%rowtype;
  v_candidate jsonb;
  v_changes jsonb;
  v_target jsonb;
  v_snapshot jsonb;
  v_item public.speaking_session_items%rowtype;
  v_variation text;
begin
  if jsonb_typeof(v_source) is distinct from 'object'
    or coalesce(v_source->>'parent_snapshot_hash','') !~ '^[a-f0-9]{64}$'
    or coalesce(v_source->>'variation','') not in ('details','role_swap')
  then raise sqlstate 'PT425' using message = 'Invalid linked practice source.'; end if;
  select * into v_parent from public.speaking_sessions
    where id=(v_source->>'parent_session_id')::uuid and user_id=p_user_id for share;
  if not found or v_parent.status <> 'completed' or v_parent.mission_plan is null then
    raise sqlstate 'PT425' using message = 'Completed planned parent is required.';
  end if;
  if v_source->>'root_session_id' is distinct from
      coalesce(v_parent.practice->>'root_session_id', v_parent.id::text)
    or p_plan->>'scenario_type' is distinct from v_parent.scenario_type
    or jsonb_array_length(p_snapshots) <> jsonb_array_length(v_parent.mission_plan->'targets')
  then raise sqlstate 'PT425' using message = 'Practice lineage does not match the parent.'; end if;
  for v_target in select value from jsonb_array_elements(v_parent.mission_plan->'targets') loop
    select * into v_item from public.speaking_session_items
      where id=(v_target->>'session_item_id')::uuid and session_id=v_parent.id;
    select value into v_snapshot from jsonb_array_elements(p_snapshots)
      where value->>'corpus_item_id'=v_target->>'corpus_item_id';
    if v_item.id is null or v_snapshot is null
      or v_snapshot->>'corpus_item_id' is distinct from coalesce(
        v_item.source_corpus_item_id::text, v_item.corpus_item_id::text)
      or jsonb_build_object('kind',v_item.kind,'text',v_item.text_snapshot,
        'meaning',v_item.meaning_snapshot,'slots',v_item.slots_snapshot)
        is distinct from jsonb_build_object('kind',v_snapshot->'kind','text',v_snapshot->'text',
          'meaning',v_snapshot->'meaning','slots',v_snapshot->'slots')
    then raise sqlstate 'PT425' using message = 'Parent language changed or is unavailable.'; end if;
  end loop;
  v_variation := v_source->>'variation';
  for v_candidate in select value from jsonb_array_elements(p_plan->'candidates') loop
    if (select jsonb_agg(jsonb_build_object('corpus_item_id',value->'corpus_item_id','role',value->'role') order by ord)
        from jsonb_array_elements(v_candidate->'targets') with ordinality t(value,ord))
      is distinct from
      (select jsonb_agg(jsonb_build_object('corpus_item_id',value->'corpus_item_id','role',value->'role') order by ord)
        from jsonb_array_elements(v_parent.mission_plan->'targets') with ordinality t(value,ord))
    then raise sqlstate 'PT425' using message = 'Practice targets must preserve the parent roles.'; end if;
    if v_variation='details' and (
      v_candidate->>'user_role' is distinct from v_parent.mission_plan->>'user_role'
      or v_candidate->>'ai_role' is distinct from v_parent.mission_plan->>'ai_role'
      or (btrim(regexp_replace(lower(v_candidate->>'setting'),'\W+',' ','g'))
            = btrim(regexp_replace(lower(v_parent.mission_plan->>'setting'),'\W+',' ','g'))
        and btrim(regexp_replace(lower(v_candidate->>'goal'),'\W+',' ','g'))
            = btrim(regexp_replace(lower(v_parent.mission_plan->>'goal'),'\W+',' ','g')))
    ) then raise sqlstate 'PT425' using message = 'Practice details must change while preserving roles.'; end if;
    if v_variation='role_swap' and (
      v_candidate->>'user_role' is distinct from v_parent.mission_plan->>'ai_role'
      or v_candidate->>'ai_role' is distinct from v_parent.mission_plan->>'user_role'
      or btrim(regexp_replace(lower(v_parent.mission_plan->>'user_role'),'\W+',' ','g'))
         = btrim(regexp_replace(lower(v_parent.mission_plan->>'ai_role'),'\W+',' ','g'))
    ) then raise sqlstate 'PT425' using message = 'Practice must swap distinct parent roles.'; end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'field',field,'before',v_parent.mission_plan->field,'after',v_candidate->field) order by ord),'[]')
      into v_changes from unnest(array['setting','goal','user_role','ai_role']) with ordinality f(field,ord)
      where v_parent.mission_plan->field is distinct from v_candidate->field;
    if v_candidate->'changes' is distinct from v_changes then
      raise sqlstate 'PT425' using message = 'Practice change descriptions do not match the scenarios.';
    end if;
  end loop;
  return v_parent.id;
end;
$$;
revoke all on function public.validate_speaking_practice(text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.validate_speaking_practice(text,jsonb,jsonb) to service_role;

create function public.save_practice_speaking_plan(p_user_id text, p_plan jsonb, p_corpus_snapshots jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  perform public.validate_speaking_practice(p_user_id,p_plan,p_corpus_snapshots);
  return public.save_speaking_plan(p_user_id,p_plan,p_corpus_snapshots);
end;
$$;
revoke all on function public.save_practice_speaking_plan(text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.save_practice_speaking_plan(text,jsonb,jsonb) to service_role;

-- The new caller passes the evidence contract explicitly. Existing RPCs and
-- submission payloads stay unchanged; recovering an old row never stamps it.
create function public.create_evidence_speaking_loadout(
  p_user_id text, p_client_id uuid, p_scenario_type text, p_goal text,
  p_difficulty text, p_feedback_level text, p_logic_template jsonb,
  p_corpus_item_ids uuid[], p_support_level text, p_evidence_contract_version text,
  p_plan_id uuid default null, p_candidate_id uuid default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_request jsonb;
  v_existing public.speaking_sessions%rowtype;
  v_plan public.speaking_plans%rowtype;
  v_parent_id uuid;
  v_created jsonb;
  v_session_id uuid;
  v_candidate jsonb;
  v_targets jsonb;
begin
  if p_user_id is null or length(btrim(p_user_id))=0 or p_client_id is null
    or (p_plan_id is null) <> (p_candidate_id is null)
    or (p_support_level is null and p_evidence_contract_version is not null)
    or (p_support_level is not null and (
      p_support_level not in ('model_frame','model_label','label_only','no_hint')
      or p_evidence_contract_version is distinct from 'speaking-evidence-v3'))
  then raise sqlstate 'PT422' using message = 'Invalid speaking evidence setup.'; end if;
  v_request := jsonb_build_object(
    'scenario_type',p_scenario_type,'goal',btrim(p_goal),'difficulty',p_difficulty,
    'feedback_level',p_feedback_level,'logic_template_id',p_logic_template->>'id',
    'corpus_item_ids',to_jsonb(p_corpus_item_ids));
  if p_support_level is not null then
    v_request := v_request || jsonb_build_object('support_level',p_support_level);
  end if;
  if p_plan_id is not null then
    v_request := v_request || jsonb_build_object('plan_id',p_plan_id,'candidate_id',p_candidate_id);
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_client_id::text,0));
  select * into v_existing from public.speaking_sessions where user_id=p_user_id and client_id=p_client_id;
  if found then
    if v_existing.request_payload is distinct from v_request then
      raise sqlstate 'PT409' using message = 'Submission already used for a different loadout.';
    end if;
    return public.get_speaking_loadout(p_user_id,v_existing.id);
  end if;
  if p_plan_id is not null then
    select * into v_plan from public.speaking_plans where id=p_plan_id and user_id=p_user_id;
    if not found then raise sqlstate 'PT404' using message = 'Speaking plan not found.'; end if;
    if jsonb_typeof(v_plan.document->'practice_source')='object' then
      if p_support_level is null then
        raise sqlstate 'PT426' using message = 'Practice requires an explicit support level.';
      end if;
      v_parent_id := public.validate_speaking_practice(p_user_id,v_plan.document,v_plan.corpus_snapshots);
    end if;
  end if;
  if p_support_level is not null then
    v_created := public.create_supported_speaking_loadout(p_user_id,p_client_id,p_scenario_type,p_goal,
      p_difficulty,p_feedback_level,p_logic_template,p_corpus_item_ids,p_support_level,p_plan_id,p_candidate_id);
  elsif p_plan_id is not null then
    v_created := public.create_planned_speaking_loadout(p_user_id,p_client_id,p_scenario_type,p_goal,
      p_difficulty,p_feedback_level,p_logic_template,p_corpus_item_ids,p_plan_id,p_candidate_id);
  else
    v_created := public.create_speaking_loadout(p_user_id,p_client_id,p_scenario_type,p_goal,
      p_difficulty,p_feedback_level,p_logic_template,p_corpus_item_ids);
  end if;
  v_session_id := (v_created->>'id')::uuid;
  if p_support_level is not null then
    update public.speaking_session_items set source_corpus_item_id=corpus_item_id where session_id=v_session_id;
    update public.speaking_sessions set evidence_contract_version=p_evidence_contract_version
      where id=v_session_id and user_id=p_user_id;
  end if;
  if v_parent_id is not null then
    select value into v_candidate from jsonb_array_elements(v_plan.document->'candidates')
      where value->>'id'=p_candidate_id::text;
    select jsonb_agg(target.value || jsonb_build_object(
      'parent_session_item_id',parent_target.value->'session_item_id') order by target.ord)
      into v_targets
      from jsonb_array_elements(v_created->'mission_plan'->'targets') with ordinality target(value,ord)
      join public.speaking_sessions parent on parent.id=v_parent_id and parent.user_id=p_user_id
      cross join lateral jsonb_array_elements(parent.mission_plan->'targets') parent_target(value)
      where parent_target.value->>'corpus_item_id'=target.value->>'corpus_item_id';
    update public.speaking_sessions set
      mission_plan=jsonb_set(mission_plan,'{targets}',v_targets),
      practice_parent_session_id=v_parent_id,
      practice=jsonb_build_object(
        'parent_session_id',v_parent_id,
        'root_session_id',v_plan.document->'practice_source'->'root_session_id',
        'variation',v_plan.document->'practice_source'->'variation','changes',v_candidate->'changes')
      where id=v_session_id and user_id=p_user_id;
  end if;
  return public.get_speaking_loadout(p_user_id,v_session_id);
end;
$$;
revoke all on function public.create_evidence_speaking_loadout(text,uuid,text,text,text,text,jsonb,uuid[],text,text,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.create_evidence_speaking_loadout(text,uuid,text,text,text,text,jsonb,uuid[],text,text,uuid,uuid)
  to service_role;

-- New feedback jobs use the extended analysis contract. Existing frozen jobs are unchanged.
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
      'speaking-rubric-v2','speaking-feedback-v3');
  return public.read_speaking_feedback(p_user_id, p_session_id);
end;
$$;

revoke all on function public.enqueue_speaking_feedback(text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.enqueue_speaking_feedback(text,uuid,boolean) to service_role;
