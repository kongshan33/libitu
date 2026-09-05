create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function private.set_updated_at() from public, anon, authenticated;

create table public.profiles (
  id text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_id_not_blank check (length(btrim(id)) > 0)
);

comment on column public.profiles.id is 'Stable Clerk user ID from the session token sub claim.';

create table public.contents (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  visibility text not null default 'public',
  owner_user_id text references public.profiles(id) on delete cascade,
  normalized_key text not null,
  source_url text,
  title text,
  language text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contents_kind_valid check (kind in ('youtube', 'article', 'pasted_text')),
  constraint contents_visibility_valid check (visibility in ('public', 'private')),
  constraint contents_normalized_key_not_blank check (length(btrim(normalized_key)) > 0),
  constraint contents_owner_matches_visibility check (
    (visibility = 'public' and owner_user_id is null)
    or (visibility = 'private' and owner_user_id is not null)
  )
);

create unique index contents_public_normalized_key_idx
  on public.contents (normalized_key)
  where visibility = 'public';
create unique index contents_private_owner_key_idx
  on public.contents (owner_user_id, normalized_key)
  where visibility = 'private';
create index contents_owner_user_id_idx on public.contents (owner_user_id);

create table private.content_payloads (
  content_id uuid primary key references public.contents(id) on delete cascade,
  transcript_text text,
  source_text text,
  content_sha256 text not null,
  created_at timestamptz not null default now(),
  constraint content_payload_present check (
    transcript_text is not null or source_text is not null
  ),
  constraint content_sha256_format check (content_sha256 ~ '^[0-9a-f]{64}$')
);

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references public.contents(id) on delete cascade,
  requested_by_user_id text references public.profiles(id) on delete set null,
  analysis_version text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint processing_jobs_analysis_version_not_blank check (length(btrim(analysis_version)) > 0),
  constraint processing_jobs_status_valid check (status in ('pending', 'processing', 'ready', 'failed')),
  constraint processing_jobs_attempt_count_valid check (attempt_count >= 0),
  constraint processing_jobs_error_shape check (
    (status = 'failed' and error_code is not null)
    or (status <> 'failed' and error_code is null and error_message is null)
  ),
  unique (content_id, analysis_version)
);

create index processing_jobs_requested_by_user_id_idx on public.processing_jobs (requested_by_user_id);
create index processing_jobs_queue_idx
  on public.processing_jobs (status, created_at)
  where status in ('pending', 'processing');

create table public.blueprints (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references public.contents(id) on delete cascade,
  analysis_version text not null,
  summary text not null,
  logic_flow jsonb not null default '[]'::jsonb,
  key_points text[] not null default '{}',
  scenario_suggestions jsonb not null default '[]'::jsonb,
  generated_at timestamptz not null default now(),
  constraint blueprints_summary_not_blank check (length(btrim(summary)) > 0),
  constraint blueprints_logic_flow_array check (jsonb_typeof(logic_flow) = 'array'),
  constraint blueprints_scenarios_array check (jsonb_typeof(scenario_suggestions) = 'array'),
  unique (content_id, analysis_version)
);

create table public.blueprint_segments (
  id uuid primary key default gen_random_uuid(),
  blueprint_id uuid not null references public.blueprints(id) on delete cascade,
  ordinal integer not null,
  kind text not null,
  title text,
  summary text,
  source_locator jsonb not null default '{}'::jsonb,
  annotations jsonb not null default '[]'::jsonb,
  constraint blueprint_segments_ordinal_valid check (ordinal >= 0),
  constraint blueprint_segments_kind_valid check (kind in ('logic', 'moment', 'transcript', 'paragraph')),
  constraint blueprint_segments_locator_object check (jsonb_typeof(source_locator) = 'object'),
  constraint blueprint_segments_annotations_array check (jsonb_typeof(annotations) = 'array'),
  unique (blueprint_id, ordinal)
);

create table public.user_content_states (
  user_id text not null references public.profiles(id) on delete cascade,
  content_id uuid not null references public.contents(id) on delete cascade,
  mode text not null default 'extensive',
  progress jsonb not null default '{}'::jsonb,
  last_opened_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_content_states_mode_valid check (mode in ('extensive', 'intensive', 'reading')),
  constraint user_content_states_progress_object check (jsonb_typeof(progress) = 'object'),
  primary key (user_id, content_id)
);

create index user_content_states_content_id_idx on public.user_content_states (content_id);
create index user_content_states_user_recent_idx
  on public.user_content_states (user_id, last_opened_at desc);

create table public.corpus_items (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(id) on delete cascade,
  content_id uuid references public.contents(id) on delete set null,
  blueprint_segment_id uuid references public.blueprint_segments(id) on delete set null,
  kind text not null,
  text text not null,
  meaning text,
  usage_context text,
  tags text[] not null default '{}',
  slots jsonb not null default '{}'::jsonb,
  source_locator jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint corpus_items_kind_valid check (kind in ('chunk', 'structure')),
  constraint corpus_items_text_not_blank check (length(btrim(text)) > 0),
  constraint corpus_items_slots_object check (jsonb_typeof(slots) = 'object'),
  constraint corpus_items_source_locator_object check (jsonb_typeof(source_locator) = 'object')
);

create index corpus_items_user_recent_idx on public.corpus_items (user_id, created_at desc);
create index corpus_items_user_kind_idx on public.corpus_items (user_id, kind);
create index corpus_items_content_id_idx on public.corpus_items (content_id);
create index corpus_items_blueprint_segment_id_idx on public.corpus_items (blueprint_segment_id);
create index corpus_items_tags_idx on public.corpus_items using gin (tags);

create table public.speaking_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(id) on delete cascade,
  scenario_type text not null,
  goal text not null,
  difficulty text not null default 'standard',
  feedback_level text not null default 'balanced',
  logic_template jsonb,
  status text not null default 'draft',
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint speaking_sessions_scenario_type_valid check (scenario_type in ('workplace', 'everyday')),
  constraint speaking_sessions_goal_not_blank check (length(btrim(goal)) > 0),
  constraint speaking_sessions_difficulty_valid check (difficulty in ('guided', 'standard', 'challenging')),
  constraint speaking_sessions_feedback_level_valid check (feedback_level in ('light', 'balanced', 'detailed')),
  constraint speaking_sessions_status_valid check (status in ('draft', 'active', 'completed', 'abandoned')),
  constraint speaking_sessions_logic_template_object check (
    logic_template is null or jsonb_typeof(logic_template) = 'object'
  )
);

create index speaking_sessions_user_recent_idx
  on public.speaking_sessions (user_id, created_at desc);

create table public.speaking_session_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.speaking_sessions(id) on delete cascade,
  corpus_item_id uuid references public.corpus_items(id) on delete set null,
  ordinal integer not null,
  kind text not null,
  text_snapshot text not null,
  tags_snapshot text[] not null default '{}',
  slots_snapshot jsonb not null default '{}'::jsonb,
  constraint speaking_session_items_ordinal_valid check (ordinal >= 0),
  constraint speaking_session_items_kind_valid check (kind in ('chunk', 'structure')),
  constraint speaking_session_items_text_not_blank check (length(btrim(text_snapshot)) > 0),
  constraint speaking_session_items_slots_object check (jsonb_typeof(slots_snapshot) = 'object'),
  unique (session_id, ordinal)
);

create index speaking_session_items_corpus_item_id_idx on public.speaking_session_items (corpus_item_id);

create table public.speaking_turns (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.speaking_sessions(id) on delete cascade,
  ordinal integer not null,
  role text not null,
  message text not null,
  detected_items jsonb not null default '[]'::jsonb,
  turn_feedback jsonb,
  logic_stage text,
  created_at timestamptz not null default now(),
  constraint speaking_turns_ordinal_valid check (ordinal >= 0),
  constraint speaking_turns_role_valid check (role in ('user', 'assistant')),
  constraint speaking_turns_message_not_blank check (length(btrim(message)) > 0),
  constraint speaking_turns_detected_items_array check (jsonb_typeof(detected_items) = 'array'),
  constraint speaking_turns_feedback_object check (
    turn_feedback is null or jsonb_typeof(turn_feedback) = 'object'
  ),
  unique (session_id, ordinal)
);

create table public.speaking_feedback (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.speaking_sessions(id) on delete cascade,
  task_fit smallint not null,
  transfer smallint not null,
  scenario_fit smallint not null,
  naturalness smallint not null,
  evidence jsonb not null default '[]'::jsonb,
  refactors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint speaking_feedback_task_fit_valid check (task_fit between 0 and 100),
  constraint speaking_feedback_transfer_valid check (transfer between 0 and 100),
  constraint speaking_feedback_scenario_fit_valid check (scenario_fit between 0 and 100),
  constraint speaking_feedback_naturalness_valid check (naturalness between 0 and 100),
  constraint speaking_feedback_evidence_array check (jsonb_typeof(evidence) = 'array'),
  constraint speaking_feedback_refactors_array check (jsonb_typeof(refactors) = 'array')
);

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function private.set_updated_at();
create trigger contents_set_updated_at
before update on public.contents
for each row execute function private.set_updated_at();
create trigger processing_jobs_set_updated_at
before update on public.processing_jobs
for each row execute function private.set_updated_at();
create trigger user_content_states_set_updated_at
before update on public.user_content_states
for each row execute function private.set_updated_at();
create trigger corpus_items_set_updated_at
before update on public.corpus_items
for each row execute function private.set_updated_at();
create trigger speaking_sessions_set_updated_at
before update on public.speaking_sessions
for each row execute function private.set_updated_at();

alter table public.profiles enable row level security;
alter table private.content_payloads enable row level security;
alter table public.contents enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.blueprints enable row level security;
alter table public.blueprint_segments enable row level security;
alter table public.user_content_states enable row level security;
alter table public.corpus_items enable row level security;
alter table public.speaking_sessions enable row level security;
alter table public.speaking_session_items enable row level security;
alter table public.speaking_turns enable row level security;
alter table public.speaking_feedback enable row level security;

create policy profiles_select_own on public.profiles
for select to authenticated
using ((select auth.jwt()->>'sub') = id);
create policy profiles_insert_own on public.profiles
for insert to authenticated
with check ((select auth.jwt()->>'sub') = id);
create policy profiles_update_own on public.profiles
for update to authenticated
using ((select auth.jwt()->>'sub') = id)
with check ((select auth.jwt()->>'sub') = id);

create policy contents_select_accessible on public.contents
for select to anon, authenticated
using (
  visibility = 'public'
  or owner_user_id = (select auth.jwt()->>'sub')
);
create policy contents_insert_private_own on public.contents
for insert to authenticated
with check (
  visibility = 'private'
  and owner_user_id = (select auth.jwt()->>'sub')
);
create policy contents_update_private_own on public.contents
for update to authenticated
using (visibility = 'private' and owner_user_id = (select auth.jwt()->>'sub'))
with check (visibility = 'private' and owner_user_id = (select auth.jwt()->>'sub'));
create policy contents_delete_private_own on public.contents
for delete to authenticated
using (visibility = 'private' and owner_user_id = (select auth.jwt()->>'sub'));

create policy processing_jobs_select_own on public.processing_jobs
for select to authenticated
using (
  requested_by_user_id = (select auth.jwt()->>'sub')
  or exists (
    select 1 from public.contents
    where contents.id = processing_jobs.content_id
      and contents.owner_user_id = (select auth.jwt()->>'sub')
  )
);

create policy blueprints_select_accessible on public.blueprints
for select to anon, authenticated
using (
  exists (
    select 1 from public.contents
    where contents.id = blueprints.content_id
      and (
        contents.visibility = 'public'
        or contents.owner_user_id = (select auth.jwt()->>'sub')
      )
  )
);

create policy blueprint_segments_select_accessible on public.blueprint_segments
for select to anon, authenticated
using (
  exists (
    select 1
    from public.blueprints
    join public.contents on contents.id = blueprints.content_id
    where blueprints.id = blueprint_segments.blueprint_id
      and (
        contents.visibility = 'public'
        or contents.owner_user_id = (select auth.jwt()->>'sub')
      )
  )
);

create policy user_content_states_own on public.user_content_states
for all to authenticated
using ((select auth.jwt()->>'sub') = user_id)
with check ((select auth.jwt()->>'sub') = user_id);

create policy corpus_items_own on public.corpus_items
for all to authenticated
using ((select auth.jwt()->>'sub') = user_id)
with check ((select auth.jwt()->>'sub') = user_id);

create policy speaking_sessions_own on public.speaking_sessions
for all to authenticated
using ((select auth.jwt()->>'sub') = user_id)
with check ((select auth.jwt()->>'sub') = user_id);

create policy speaking_session_items_own on public.speaking_session_items
for all to authenticated
using (
  exists (
    select 1 from public.speaking_sessions
    where speaking_sessions.id = speaking_session_items.session_id
      and speaking_sessions.user_id = (select auth.jwt()->>'sub')
  )
)
with check (
  exists (
    select 1 from public.speaking_sessions
    where speaking_sessions.id = speaking_session_items.session_id
      and speaking_sessions.user_id = (select auth.jwt()->>'sub')
  )
);

create policy speaking_turns_own on public.speaking_turns
for all to authenticated
using (
  exists (
    select 1 from public.speaking_sessions
    where speaking_sessions.id = speaking_turns.session_id
      and speaking_sessions.user_id = (select auth.jwt()->>'sub')
  )
)
with check (
  exists (
    select 1 from public.speaking_sessions
    where speaking_sessions.id = speaking_turns.session_id
      and speaking_sessions.user_id = (select auth.jwt()->>'sub')
  )
);

create policy speaking_feedback_own on public.speaking_feedback
for all to authenticated
using (
  exists (
    select 1 from public.speaking_sessions
    where speaking_sessions.id = speaking_feedback.session_id
      and speaking_sessions.user_id = (select auth.jwt()->>'sub')
  )
)
with check (
  exists (
    select 1 from public.speaking_sessions
    where speaking_sessions.id = speaking_feedback.session_id
      and speaking_sessions.user_id = (select auth.jwt()->>'sub')
  )
);

grant usage on schema public to anon, authenticated;
grant select on public.contents, public.blueprints, public.blueprint_segments to anon, authenticated;
grant select on public.processing_jobs to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant insert, update, delete on public.contents to authenticated;
grant select, insert, update, delete on
  public.user_content_states,
  public.corpus_items,
  public.speaking_sessions,
  public.speaking_session_items,
  public.speaking_turns,
  public.speaking_feedback
to authenticated;
