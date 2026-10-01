-- Clerk identity is verified by FastAPI; browsers have no direct table/bucket access.
create table public.shadow_attempts (
  id uuid primary key,
  user_id text not null references public.profiles(id),
  content_id uuid not null references public.contents(id),
  sentence_id text not null,
  sentence_text text not null,
  start_ms bigint not null,
  end_ms bigint not null check (end_ms > start_ms and start_ms >= 0),
  reference_version text not null,
  duration_ms integer not null check (duration_ms > 0 and duration_ms <= 61000),
  playback_rate double precision not null check (playback_rate between 0.25 and 2),
  text_visible boolean not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  recording_state text not null check (recording_state in ('none', 'pending', 'ready', 'deleted')),
  recording_sha256 text,
  recording_bytes integer check (recording_bytes between 1 and 8388608),
  recording_mime text check (recording_mime in ('audio/webm', 'audio/ogg', 'audio/mp4')),
  recording_consent_at timestamptz,
  consent_version text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint shadow_recording_metadata check (
    (recording_sha256 is null and recording_bytes is null and recording_mime is null
      and recording_consent_at is null and consent_version is null and recording_state in ('none', 'deleted'))
    or (recording_sha256 ~ '^[0-9a-f]{64}$' and recording_bytes is not null
      and recording_mime is not null and recording_consent_at is not null and consent_version = 'recording-retention-v1')
  )
);
create index shadow_attempts_owner_history_idx on public.shadow_attempts(user_id, content_id, sentence_id, created_at desc, id desc);
create index shadow_attempts_content_idx on public.shadow_attempts(content_id);
alter table public.shadow_attempts enable row level security;
revoke all on public.shadow_attempts from public, anon, authenticated;
grant select, insert, update, delete on public.shadow_attempts to service_role;
create policy shadow_attempts_service on public.shadow_attempts to service_role using (true) with check (true);
comment on table public.shadow_attempts is 'Private Shadow attempts. Server-verified source; browser-reported duration and conditions, not pronunciation assessments. Tombstones prevent late retries from resurrecting deleted recordings.';

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('shadow-recordings', 'shadow-recordings', false, 8388608, array['audio/webm', 'audio/ogg', 'audio/mp4']);
-- No client storage policies: upload, read and removal go through owner-checked API.
