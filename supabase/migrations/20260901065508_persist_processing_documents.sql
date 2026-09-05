alter table public.blueprints
add column document jsonb not null default '{}'::jsonb;

alter table public.blueprints
add constraint blueprints_document_object
check (jsonb_typeof(document) = 'object');

create or replace function public.upsert_content_payload(
  p_content_id uuid,
  p_transcript_text text,
  p_source_text text,
  p_content_sha256 text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.content_payloads (
    content_id,
    transcript_text,
    source_text,
    content_sha256
  )
  values (
    p_content_id,
    p_transcript_text,
    p_source_text,
    p_content_sha256
  )
  on conflict (content_id) do update
  set transcript_text = excluded.transcript_text,
      source_text = excluded.source_text,
      content_sha256 = excluded.content_sha256;
$$;

create or replace function public.get_content_payload(p_content_id uuid)
returns table (
  transcript_text text,
  source_text text,
  content_sha256 text
)
language sql
stable
security definer
set search_path = ''
as $$
  select payload.transcript_text, payload.source_text, payload.content_sha256
  from private.content_payloads as payload
  where payload.content_id = p_content_id;
$$;

revoke all on function public.upsert_content_payload(uuid, text, text, text)
from public, anon, authenticated;
revoke all on function public.get_content_payload(uuid)
from public, anon, authenticated;

grant execute on function public.upsert_content_payload(uuid, text, text, text)
to service_role;
grant execute on function public.get_content_payload(uuid)
to service_role;
