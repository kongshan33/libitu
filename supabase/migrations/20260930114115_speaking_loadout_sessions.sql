-- FastAPI verifies Clerk ownership. Speaking writes use only the atomic server RPC;
-- clients cannot rewrite snapshots through the Data API.
alter table public.speaking_sessions
  add column client_id uuid,
  add column request_payload jsonb,
  add constraint speaking_sessions_submission_shape check (
    (client_id is null and request_payload is null)
    or (client_id is not null and request_payload is not null and jsonb_typeof(request_payload) = 'object')
  );
create unique index speaking_sessions_owner_client_idx on public.speaking_sessions(user_id, client_id);

alter table public.speaking_session_items
  drop constraint speaking_session_items_kind_valid,
  add constraint speaking_session_items_kind_valid check (kind in ('chunk', 'idiom', 'structure')),
  add column meaning_snapshot text,
  add column source_title_snapshot text;

revoke all on public.speaking_sessions, public.speaking_session_items,
  public.speaking_turns, public.speaking_feedback from public, anon, authenticated;
grant select, insert, update, delete on public.speaking_sessions, public.speaking_session_items,
  public.speaking_turns, public.speaking_feedback to service_role;

create function public.get_speaking_loadout(p_user_id text, p_session_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id, 'user_id', s.user_id, 'client_id', s.client_id,
    'scenario_type', s.scenario_type, 'goal', s.goal, 'difficulty', s.difficulty,
    'feedback_level', s.feedback_level, 'logic_template', s.logic_template,
    'status', s.status, 'created_at', s.created_at,
    'turn_count', (select count(*) from public.speaking_turns t where t.session_id = s.id and t.role = 'user'),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'corpus_item_id', i.corpus_item_id, 'ordinal', i.ordinal,
        'kind', i.kind, 'text', i.text_snapshot, 'meaning', i.meaning_snapshot,
        'tags', i.tags_snapshot, 'slots', i.slots_snapshot, 'source_title', i.source_title_snapshot
      ) order by i.ordinal)
      from public.speaking_session_items i where i.session_id = s.id
    ), '[]'::jsonb)
  )
  from public.speaking_sessions s
  where s.id = p_session_id and s.user_id = p_user_id and s.client_id is not null;
$$;

create function public.create_speaking_loadout(
  p_user_id text,
  p_client_id uuid,
  p_scenario_type text,
  p_goal text,
  p_difficulty text,
  p_feedback_level text,
  p_logic_template jsonb,
  p_corpus_item_ids uuid[]
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
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
  then
    raise sqlstate 'PT422' using message = 'Invalid speaking loadout.';
  end if;
  if p_logic_template is not null and (
    jsonb_typeof(p_logic_template) <> 'object'
    or coalesce(p_logic_template->>'id', '') not in (
      'persuasive_pitch', 'technical_troubleshoot', 'stakeholder_alignment',
      'status_update', 'disagreement', 'onboarding'
    )
    or jsonb_typeof(p_logic_template->'steps') is distinct from 'array'
  ) then
    raise sqlstate 'PT422' using message = 'Invalid logic template.';
  end if;

  -- Keep the user's normalized request separate from the immutable content snapshot.
  -- A retry after source edits/deletion or a later catalog revision returns the first snapshot.
  v_request := jsonb_build_object(
    'scenario_type', p_scenario_type, 'goal', btrim(p_goal), 'difficulty', p_difficulty,
    'feedback_level', p_feedback_level, 'logic_template_id', p_logic_template->>'id',
    'corpus_item_ids', to_jsonb(p_corpus_item_ids)
  );
  perform pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_client_id::text, 0));
  select * into v_existing from public.speaking_sessions
    where user_id = p_user_id and client_id = p_client_id;
  if found then
    if v_existing.request_payload is distinct from v_request then
      raise sqlstate 'PT409' using message = 'Submission already used for a different loadout.';
    end if;
    return public.get_speaking_loadout(p_user_id, v_existing.id);
  end if;

  -- Lock owned rows in stable order. Edits/deletion cannot race validation and snapshotting.
  perform c.id from public.corpus_items c
    where c.id = any(p_corpus_item_ids) and c.user_id = p_user_id
    order by c.id for share;
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
    slots_snapshot, meaning_snapshot, source_title_snapshot
  )
  select v_session_id, c.id, (requested.ordinal - 1)::integer, c.kind, c.text,
    c.tags, c.slots, c.meaning, c.source_locator->>'source_title'
  from unnest(p_corpus_item_ids) with ordinality requested(id, ordinal)
  join public.corpus_items c on c.id = requested.id and c.user_id = p_user_id;

  return public.get_speaking_loadout(p_user_id, v_session_id);
end;
$$;

revoke all on function public.get_speaking_loadout(text, uuid) from public, anon, authenticated;
revoke all on function public.create_speaking_loadout(text, uuid, text, text, text, text, jsonb, uuid[])
  from public, anon, authenticated;
grant execute on function public.get_speaking_loadout(text, uuid) to service_role;
grant execute on function public.create_speaking_loadout(text, uuid, text, text, text, text, jsonb, uuid[])
  to service_role;

comment on function public.create_speaking_loadout(text, uuid, text, text, text, text, jsonb, uuid[])
  is 'Server-only atomic owner-checked speaking setup. Same owner/client ID replays the original snapshot; changed payload conflicts. No role-play provider is called.';
