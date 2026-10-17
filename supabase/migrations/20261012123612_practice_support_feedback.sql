-- Browser-reported support conditions and user disagreement, not new assessments.
alter table public.shadow_attempts
  add column text_support jsonb,
  add column recognition_feedback jsonb,
  add constraint shadow_text_support_shape check (text_support is null or (
    jsonb_typeof(text_support)='object' and text_support->>'version'='text-support-v1'
    and text_support->>'mode' in ('hidden','keywords','full')
    and jsonb_typeof(text_support->'visible_source_indices_at_start')='array'
    and jsonb_typeof(text_support->'revealed_source_indices')='array'
  ) is true),
  add constraint shadow_recognition_feedback_shape check (recognition_feedback is null or (
    jsonb_typeof(recognition_feedback)='object' and recognition_feedback->>'kind'='recognition_error'
    and jsonb_typeof(recognition_feedback->'created_at')='string'
  ) is true);

create function public.preserve_practice_support() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if old.deleted_at is not null and new.deleted_at is null then raise exception 'Deleted practice cannot be restored'; end if;
  if new.deleted_at is not null then
    new.text_support=null;
    new.recognition_feedback=null;
  else
    if new.text_support is distinct from old.text_support then raise exception 'Text support snapshot is immutable'; end if;
    if old.recognition_feedback is not null and new.recognition_feedback is distinct from old.recognition_feedback
      then raise exception 'Recognition feedback is immutable'; end if;
  end if;
  return new;
end $$;
create trigger preserve_practice_support before update on public.shadow_attempts
for each row execute function public.preserve_practice_support();

create function public.mark_practice_recognition_error(p_id uuid,p_owner text)
returns setof public.shadow_attempts language plpgsql security invoker set search_path='' as $$
declare r public.shadow_attempts; checked jsonb;
begin
  -- Lock the parent first, as record deletion does. Repeated calls retain the original timestamp.
  select * into r from public.shadow_attempts where id=p_id and user_id=p_owner for update;
  if not found or r.deleted_at is not null then return; end if;
  if r.recognition_feedback is null then
    select word_check into checked from public.practice_analyses
      where id=p_id and user_id=p_owner and state<>'deleted';
    if checked is null or checked->>'status' is distinct from 'reliable' or not exists(
      select 1 from jsonb_array_elements(checked->'operations') op where op->>'kind' in ('substituted','omitted','inserted'))
      then return; end if;
    update public.shadow_attempts set recognition_feedback=jsonb_build_object('kind','recognition_error','created_at',now()) where id=p_id;
  end if;
  return query select * from public.shadow_attempts where id=p_id;
end $$;
revoke all on function public.preserve_practice_support(),public.mark_practice_recognition_error(uuid,text)
  from public,anon,authenticated;
grant execute on function public.preserve_practice_support(),public.mark_practice_recognition_error(uuid,text) to service_role;
-- Existing table RLS and service-only grants are retained; no client grants or backfill of old conditions.
