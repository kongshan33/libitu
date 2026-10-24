-- Plans are server-owned suggestions. A Mission freezes one validated candidate and
-- the exact language used to generate it in the existing atomic creation boundary.
create table public.speaking_plans (
  id uuid primary key,
  user_id text not null references public.profiles(id) on delete cascade,
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  corpus_snapshots jsonb not null check (jsonb_typeof(corpus_snapshots) = 'array'),
  content_hash text not null,
  created_at timestamptz not null default now(),
  constraint speaking_plan_document_size check (octet_length(document::text) <= 65536),
  constraint speaking_plan_snapshot_size check (octet_length(corpus_snapshots::text) <= 65536)
);
create index speaking_plans_owner_idx on public.speaking_plans(user_id, created_at desc);
alter table public.speaking_plans enable row level security;
revoke all on public.speaking_plans from public, anon, authenticated, service_role;
grant select, insert, delete on public.speaking_plans to service_role;
create policy speaking_plans_server_only on public.speaking_plans
  for all to service_role using (true) with check (true);

alter table public.speaking_sessions
  add column mission_plan jsonb,
  add constraint speaking_sessions_mission_plan_object
    check (mission_plan is null or jsonb_typeof(mission_plan) = 'object');
alter table public.speaking_session_items
  add column usage_note_snapshot text,
  add column register_snapshot text,
  add column scenario_tags_snapshot jsonb not null default '[]'::jsonb,
  add column pattern_family_snapshot text,
  add constraint speaking_session_item_register_valid
    check (register_snapshot is null or register_snapshot in ('casual', 'neutral', 'professional', 'formal')),
  add constraint speaking_session_item_scenarios_array
    check (jsonb_typeof(scenario_tags_snapshot) = 'array');

-- Canonical planning input is also used for the stale-plan comparison. Missing
-- source metadata remains null/empty; daily_life is preserved as original evidence.
create function public.speaking_corpus_snapshot(p_item public.corpus_items)
returns jsonb language sql immutable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'corpus_item_id', p_item.id, 'kind', p_item.kind, 'text', p_item.text,
    'meaning', p_item.meaning, 'usage_note', p_item.usage_context,
    'tags', p_item.tags, 'slots', p_item.slots,
    'source_title', p_item.source_locator->>'source_title',
    'register', case when p_item.source_locator->'snapshot'->>'register'
      in ('casual', 'neutral', 'professional', 'formal')
      then p_item.source_locator->'snapshot'->>'register' else null end,
    'scenario_tags', case when jsonb_typeof(p_item.source_locator->'snapshot'->'scenario_tags') = 'array'
      then p_item.source_locator->'snapshot'->'scenario_tags' else '[]'::jsonb end,
    'pattern_family', case when p_item.kind = 'structure'
      then p_item.source_locator->'snapshot'->>'pattern_family' else null end
  );
$$;
revoke all on function public.speaking_corpus_snapshot(public.corpus_items) from public, anon, authenticated;
grant execute on function public.speaking_corpus_snapshot(public.corpus_items) to service_role;

create function public.get_speaking_plan(p_user_id text, p_plan_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select document from public.speaking_plans where id = p_plan_id and user_id = p_user_id;
$$;

create function public.save_speaking_plan(p_user_id text, p_plan jsonb, p_corpus_snapshots jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_ids uuid[];
  v_current jsonb;
  v_existing public.speaking_plans%rowtype;
  v_candidate jsonb;
  v_count integer;
begin
  if p_user_id is null or length(btrim(p_user_id)) = 0
    or jsonb_typeof(p_plan) is distinct from 'object'
    or p_plan->>'version' is distinct from '1'
    or coalesce(p_plan->>'scenario_type', '') not in ('workplace', 'everyday')
    or jsonb_typeof(p_plan->'candidates') is distinct from 'array'
    or jsonb_typeof(p_corpus_snapshots) is distinct from 'array'
  then raise sqlstate 'PT422' using message = 'Invalid speaking plan.'; end if;
  if jsonb_array_length(p_plan->'candidates') not between 2 and 3
    or jsonb_array_length(p_corpus_snapshots) not between 1 and 5
  then raise sqlstate 'PT422' using message = 'Invalid speaking plan size.'; end if;
  select array_agg((value->>'corpus_item_id')::uuid order by ordinal)
    into v_ids from jsonb_array_elements(p_corpus_snapshots) with ordinality source(value, ordinal);
  if array_position(v_ids, null) is not null
    or (select count(distinct id) from unnest(v_ids) ids(id)) <> cardinality(v_ids)
  then raise sqlstate 'PT422' using message = 'Invalid speaking plan targets.'; end if;
  for v_candidate in select value from jsonb_array_elements(p_plan->'candidates') loop
    if jsonb_typeof(v_candidate->'targets') is distinct from 'array' then
      raise sqlstate 'PT422' using message = 'Invalid scenario targets.';
    end if;
    if (select array_agg((value->>'corpus_item_id')::uuid order by ordinal)
      from jsonb_array_elements(v_candidate->'targets') with ordinality targets(value, ordinal))
      is distinct from v_ids then
      raise sqlstate 'PT422' using message = 'Scenario targets do not match the plan.';
    end if;
    select count(*) filter (where value->>'role' = 'primary') into v_count
      from jsonb_array_elements(v_candidate->'targets');
    if v_count not between 1 and 3 or cardinality(v_ids) - v_count > 2
      or exists (select 1 from jsonb_array_elements(v_candidate->'targets')
        where coalesce(value->>'role', '') not in ('primary', 'opportunity')
          or coalesce(value->>'fit', '') not in ('high', 'medium', 'low', 'unknown')
          or length(btrim(coalesce(value->>'trigger_question', ''))) = 0)
    then raise sqlstate 'PT422' using message = 'Invalid scenario roles or opportunities.'; end if;
  end loop;
  perform c.id from public.corpus_items c
    where c.id = any(v_ids) and c.user_id = p_user_id order by c.id for share;
  select jsonb_agg(public.speaking_corpus_snapshot(c) order by requested.ordinal)
    into v_current from unnest(v_ids) with ordinality requested(id, ordinal)
    join public.corpus_items c on c.id = requested.id and c.user_id = p_user_id;
  if coalesce(jsonb_array_length(v_current), 0) <> cardinality(v_ids) then
    raise sqlstate 'PT404' using message = 'Selected corpus items are unavailable.';
  end if;
  if v_current is distinct from p_corpus_snapshots then
    raise sqlstate 'PT412' using message = 'Selected language changed during planning.';
  end if;
  insert into public.profiles(id) values (p_user_id) on conflict (id) do nothing;
  insert into public.speaking_plans(id, user_id, document, corpus_snapshots, content_hash, created_at)
    values ((p_plan->>'id')::uuid, p_user_id, p_plan, p_corpus_snapshots,
      encode(sha256(convert_to(p_corpus_snapshots::text, 'UTF8')), 'hex'), (p_plan->>'created_at')::timestamptz)
    on conflict (id) do nothing;
  select * into v_existing from public.speaking_plans where id = (p_plan->>'id')::uuid;
  if v_existing.user_id is distinct from p_user_id or v_existing.document is distinct from p_plan
    or v_existing.corpus_snapshots is distinct from p_corpus_snapshots then
    raise sqlstate 'PT409' using message = 'Plan ID already belongs to different content.';
  end if;
  return v_existing.document;
end;
$$;

create or replace function public.get_speaking_loadout(p_user_id text, p_session_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id, 'user_id', s.user_id, 'client_id', s.client_id,
    'scenario_type', s.scenario_type, 'goal', s.goal, 'difficulty', s.difficulty,
    'feedback_level', s.feedback_level, 'logic_template', s.logic_template,
    'status', s.status, 'created_at', s.created_at, 'turn_count', s.turn_count,
    'mission_plan', s.mission_plan,
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

-- Preserve the legacy signature and normalized request. The enriched language
-- snapshot is written for both entry paths; retries still return the first snapshot.
create or replace function public.create_speaking_loadout(
  p_user_id text, p_client_id uuid, p_scenario_type text, p_goal text,
  p_difficulty text, p_feedback_level text, p_logic_template jsonb, p_corpus_item_ids uuid[]
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_request jsonb;
  v_existing public.speaking_sessions%rowtype;
  v_session_id uuid;
  v_selected_count integer;
  v_structures integer;
  v_expressions integer;
begin
  if p_user_id is null or length(btrim(p_user_id)) = 0 or p_client_id is null
    or p_scenario_type is null or p_scenario_type not in ('workplace', 'everyday')
    or p_goal is null or length(btrim(p_goal)) not between 1 and 500
    or p_difficulty is null or p_difficulty not in ('guided', 'standard', 'challenging')
    or p_feedback_level is null or p_feedback_level not in ('light', 'balanced', 'detailed')
    or p_corpus_item_ids is null or cardinality(p_corpus_item_ids) not between 1 and 8
    or array_position(p_corpus_item_ids, null) is not null
    or (select count(distinct id) from unnest(p_corpus_item_ids) ids(id)) <> cardinality(p_corpus_item_ids)
  then raise sqlstate 'PT422' using message = 'Invalid speaking loadout.'; end if;
  if p_logic_template is not null and (
    jsonb_typeof(p_logic_template) <> 'object'
    or coalesce(p_logic_template->>'id', '') not in (
      'persuasive_pitch', 'technical_troubleshoot', 'stakeholder_alignment',
      'status_update', 'disagreement', 'onboarding')
    or jsonb_typeof(p_logic_template->'steps') is distinct from 'array'
  ) then raise sqlstate 'PT422' using message = 'Invalid logic template.'; end if;
  v_request := jsonb_build_object(
    'scenario_type', p_scenario_type, 'goal', btrim(p_goal), 'difficulty', p_difficulty,
    'feedback_level', p_feedback_level, 'logic_template_id', p_logic_template->>'id',
    'corpus_item_ids', to_jsonb(p_corpus_item_ids));
  perform pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_client_id::text, 0));
  select * into v_existing from public.speaking_sessions
    where user_id = p_user_id and client_id = p_client_id;
  if found then
    if v_existing.request_payload is distinct from v_request then
      raise sqlstate 'PT409' using message = 'Submission already used for a different loadout.';
    end if;
    return public.get_speaking_loadout(p_user_id, v_existing.id);
  end if;
  perform c.id from public.corpus_items c
    where c.id = any(p_corpus_item_ids) and c.user_id = p_user_id order by c.id for share;
  select count(*), count(*) filter (where kind = 'structure'),
    count(*) filter (where kind in ('chunk', 'idiom'))
    into v_selected_count, v_structures, v_expressions
    from public.corpus_items where id = any(p_corpus_item_ids) and user_id = p_user_id;
  if v_selected_count <> cardinality(p_corpus_item_ids) then
    raise sqlstate 'PT404' using message = 'Selected corpus items are unavailable.';
  end if;
  if v_structures > 3 or v_expressions > 5 or v_structures + v_expressions <> v_selected_count then
    raise sqlstate 'PT422' using message = 'Loadout selection limits exceeded.';
  end if;
  insert into public.profiles(id) values (p_user_id) on conflict (id) do nothing;
  insert into public.speaking_sessions(
    user_id, client_id, request_payload, scenario_type, goal, difficulty,
    feedback_level, logic_template, status
  ) values (
    p_user_id, p_client_id, v_request, p_scenario_type, btrim(p_goal), p_difficulty,
    p_feedback_level, p_logic_template, 'draft'
  ) returning id into v_session_id;
  insert into public.speaking_session_items(
    session_id, corpus_item_id, ordinal, kind, text_snapshot, tags_snapshot,
    slots_snapshot, meaning_snapshot, source_title_snapshot,
    usage_note_snapshot, register_snapshot, scenario_tags_snapshot, pattern_family_snapshot
  )
  select v_session_id, c.id, (requested.ordinal - 1)::integer, c.kind, c.text,
    c.tags, c.slots, c.meaning, c.source_locator->>'source_title',
    c.usage_context, public.speaking_corpus_snapshot(c)->>'register',
    public.speaking_corpus_snapshot(c)->'scenario_tags', public.speaking_corpus_snapshot(c)->>'pattern_family'
  from unnest(p_corpus_item_ids) with ordinality requested(id, ordinal)
  join public.corpus_items c on c.id = requested.id and c.user_id = p_user_id;
  return public.get_speaking_loadout(p_user_id, v_session_id);
end;
$$;

create function public.create_planned_speaking_loadout(
  p_user_id text, p_client_id uuid, p_scenario_type text, p_goal text,
  p_difficulty text, p_feedback_level text, p_logic_template jsonb,
  p_corpus_item_ids uuid[], p_plan_id uuid, p_candidate_id uuid
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_request jsonb;
  v_existing public.speaking_sessions%rowtype;
  v_plan public.speaking_plans%rowtype;
  v_candidate jsonb;
  v_current jsonb;
  v_created jsonb;
  v_session_id uuid;
  v_targets jsonb;
begin
  if p_user_id is null or length(btrim(p_user_id)) = 0 or p_client_id is null
    or p_plan_id is null or p_candidate_id is null then
    raise sqlstate 'PT422' using message = 'A saved plan and candidate are required.';
  end if;
  v_request := jsonb_build_object(
    'scenario_type', p_scenario_type, 'goal', btrim(p_goal), 'difficulty', p_difficulty,
    'feedback_level', p_feedback_level, 'logic_template_id', p_logic_template->>'id',
    'corpus_item_ids', to_jsonb(p_corpus_item_ids), 'plan_id', p_plan_id, 'candidate_id', p_candidate_id);
  perform pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_client_id::text, 0));
  select * into v_existing from public.speaking_sessions
    where user_id = p_user_id and client_id = p_client_id;
  -- Recovery precedes plan/source lookup so deletion cannot break a committed retry.
  if found then
    if v_existing.request_payload is distinct from v_request then
      raise sqlstate 'PT409' using message = 'Submission already used for a different loadout.';
    end if;
    return public.get_speaking_loadout(p_user_id, v_existing.id);
  end if;
  select * into v_plan from public.speaking_plans
    where id = p_plan_id and user_id = p_user_id;
  if not found then raise sqlstate 'PT404' using message = 'Speaking plan not found.'; end if;
  select value into v_candidate from jsonb_array_elements(v_plan.document->'candidates')
    where value->>'id' = p_candidate_id::text;
  if v_candidate is null then raise sqlstate 'PT404' using message = 'Speaking scenario not found.'; end if;
  if v_plan.document->>'scenario_type' is distinct from p_scenario_type
    or v_candidate->>'goal' is distinct from btrim(p_goal)
    or (select array_agg((value->>'corpus_item_id')::uuid order by ordinal)
      from jsonb_array_elements(v_candidate->'targets') with ordinality targets(value, ordinal))
      is distinct from p_corpus_item_ids
  then raise sqlstate 'PT409' using message = 'Scenario does not match the submitted setup.'; end if;
  if exists (select 1 from jsonb_array_elements(v_candidate->'targets')
    where value->>'role' = 'primary' and coalesce(value->>'fit', '') not in ('high', 'medium')) then
    raise sqlstate 'PT424' using message = 'Primary targets must fit the selected scenario.';
  end if;
  perform c.id from public.corpus_items c
    where c.id = any(p_corpus_item_ids) and c.user_id = p_user_id order by c.id for share;
  select jsonb_agg(public.speaking_corpus_snapshot(c) order by requested.ordinal)
    into v_current from unnest(p_corpus_item_ids) with ordinality requested(id, ordinal)
    join public.corpus_items c on c.id = requested.id and c.user_id = p_user_id;
  if coalesce(jsonb_array_length(v_current), 0) <> cardinality(p_corpus_item_ids) then
    raise sqlstate 'PT404' using message = 'Selected corpus items are unavailable.';
  end if;
  if v_current is distinct from v_plan.corpus_snapshots
    or encode(sha256(convert_to(v_current::text, 'UTF8')), 'hex') is distinct from v_plan.content_hash then
    raise sqlstate 'PT412' using message = 'Selected language changed after planning.';
  end if;
  v_created := public.create_speaking_loadout(
    p_user_id, p_client_id, p_scenario_type, p_goal, p_difficulty,
    p_feedback_level, p_logic_template, p_corpus_item_ids);
  v_session_id := (v_created->>'id')::uuid;
  select jsonb_agg(target.value || jsonb_build_object('session_item_id', i.id) order by target.ordinal)
    into v_targets from jsonb_array_elements(v_candidate->'targets') with ordinality target(value, ordinal)
    join public.speaking_session_items i on i.session_id = v_session_id
      and i.corpus_item_id = (target.value->>'corpus_item_id')::uuid;
  update public.speaking_sessions set request_payload = v_request,
    mission_plan = (v_candidate - array['id', 'targets']) || jsonb_build_object(
      'plan_id', p_plan_id, 'candidate_id', p_candidate_id,
      'version', (v_plan.document->>'version')::integer,
      'scenario_type', p_scenario_type, 'targets', v_targets)
    where id = v_session_id and user_id = p_user_id;
  return public.get_speaking_loadout(p_user_id, v_session_id);
end;
$$;

revoke all on function public.get_speaking_plan(text, uuid) from public, anon, authenticated;
revoke all on function public.save_speaking_plan(text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.create_planned_speaking_loadout(text, uuid, text, text, text, text, jsonb, uuid[], uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_speaking_plan(text, uuid) to service_role;
grant execute on function public.save_speaking_plan(text, jsonb, jsonb) to service_role;
grant execute on function public.create_planned_speaking_loadout(text, uuid, text, text, text, text, jsonb, uuid[], uuid, uuid)
  to service_role;
