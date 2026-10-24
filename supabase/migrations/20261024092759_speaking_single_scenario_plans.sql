-- Automatic Mission startup saves one validated scenario. Manual comparison and
-- legacy two/three-candidate plans retain the same source and ownership contract.
create or replace function public.save_speaking_plan(p_user_id text, p_plan jsonb, p_corpus_snapshots jsonb)
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
  if jsonb_array_length(p_plan->'candidates') not between 1 and 3
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

revoke all on function public.save_speaking_plan(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_speaking_plan(text, jsonb, jsonb) to service_role;
