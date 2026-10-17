-- A single scalar avoids Data API row limits and does not expose take text or scores.
create function public.practice_directory_progress(p_owner text, p_content uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(sentence_id order by sentence_id), '[]'::jsonb)
  from (
    select distinct sentence_id from public.shadow_attempts
    where user_id=p_owner and content_id=p_content and deleted_at is null
  ) practiced;
$$;
revoke all on function public.practice_directory_progress(text,uuid) from public,anon,authenticated;
grant execute on function public.practice_directory_progress(text,uuid) to service_role;
