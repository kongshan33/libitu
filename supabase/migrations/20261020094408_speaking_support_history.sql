-- Read only the requested language from at most 100 existing owner-bound reports.
-- No report creation, model work, source mutation or mastery state is involved.
create function public.read_speaking_support_history(
  p_user_id text, p_corpus_item_ids uuid[], p_limit integer default 100
)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_result jsonb;
begin
  if p_user_id is null or length(btrim(p_user_id)) = 0
    or p_corpus_item_ids is null or cardinality(p_corpus_item_ids) not between 1 and 5
    or array_position(p_corpus_item_ids,null) is not null
    or (select count(distinct id) from unnest(p_corpus_item_ids) id) <> cardinality(p_corpus_item_ids)
    or p_limit is null or p_limit not between 1 and 100 then
    raise sqlstate 'PT422' using message = 'Invalid practice history selection.';
  end if;
  with recent as materialized (
    select f.id, f.session_id, f.status, f.rubric_version, f.analysis_version,
      f.created_at, f.source, f.result
    from public.speaking_sessions s
    join public.speaking_feedback f on f.session_id = s.id
    where s.user_id = p_user_id and s.client_id is not null and s.status = 'completed'
      and f.source is not null and f.source->'session'->>'user_id' = p_user_id
      and exists (
        select 1 from jsonb_array_elements(coalesce(f.source->'session'->'items','[]'::jsonb)) i
        where i->>'source_corpus_item_id' = any(p_corpus_item_ids::text[])
      )
    order by f.created_at desc, f.id desc limit p_limit + 1
  ), bounded as (
    select * from recent order by created_at desc,id desc limit p_limit
  ), projected as (
    select b.created_at,b.id,jsonb_build_object(
      'id',b.id,'session_id',b.session_id,'status',b.status,
      'rubric_version',b.rubric_version,'analysis_version',b.analysis_version,
      -- Practice date is the frozen Mission start date, never a later report retry.
      'practiced_at',b.source->'session'->'created_at',
      'evidence_contract_version',b.source->'session'->'evidence_contract_version',
      'root_session_id',coalesce(b.source->'session'->'practice'->>'root_session_id',b.session_id::text),
      'scene',coalesce((select jsonb_object_agg(key,value)
        from jsonb_each(coalesce(nullif(b.source->'session'->'mission_plan','null'::jsonb),'{}'::jsonb))
        where key = any(array['setting','goal','user_role','ai_role'])),'{}'::jsonb),
      'items',coalesce((
        select jsonb_agg(jsonb_build_object(
          'item',(select jsonb_object_agg(key,value) from jsonb_each(i)
            where key = any(array['id','source_corpus_item_id','kind','text','meaning','slots'])),
          'target_role',(select t->'role'
            from jsonb_array_elements(coalesce(b.source->'session'->'mission_plan'->'targets','[]'::jsonb)) t
            where t->>'session_item_id'=i->>'id' limit 1),
          'skipped',coalesce(b.source->'target_states'->(i->>'id')->'skipped','false'::jsonb),
          'result',coalesce((select jsonb_object_agg(key,value) from jsonb_each(coalesce(r.row,'{}'::jsonb))
            where key = any(array['session_item_id','status','role','opportunity_status','excluded_reason',
              'independent_uses','qualifying_independent_evidence'])),'{}'::jsonb),
          'messages',coalesce((
            select jsonb_agg((select jsonb_object_agg(key,value) from jsonb_each(m)
              where key = any(array['id','role','status','revision','text','ordinal'])))
            from jsonb_array_elements(coalesce(b.source->'messages','[]'::jsonb)) m
            where exists (select 1 from jsonb_array_elements(
              coalesce(r.row->'qualifying_independent_evidence','[]'::jsonb)) e
              where e->>'message_id'=m->>'id')
          ),'[]'::jsonb)
        ) order by ord)
        from jsonb_array_elements(coalesce(b.source->'session'->'items','[]'::jsonb))
          with ordinality selected(i,ord)
        left join lateral (
          select row from jsonb_array_elements(coalesce(b.result->'item_results','[]'::jsonb)) row
          where row->>'session_item_id'=i->>'id' limit 1
        ) r on true
        where i->>'source_corpus_item_id'=any(p_corpus_item_ids::text[])
      ),'[]'::jsonb)
    ) row from bounded b
  )
  select jsonb_build_object(
    'reports',coalesce((select jsonb_agg(row order by created_at desc,id desc) from projected),'[]'::jsonb),
    'has_more',(select count(*) > p_limit from recent)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.read_speaking_support_history(text,uuid[],integer)
  from public,anon,authenticated;
grant execute on function public.read_speaking_support_history(text,uuid[],integer) to service_role;
