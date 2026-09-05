alter policy profiles_select_own on public.profiles
using (((select auth.jwt())->>'sub') = id);

alter policy profiles_insert_own on public.profiles
with check (((select auth.jwt())->>'sub') = id);

alter policy profiles_update_own on public.profiles
using (((select auth.jwt())->>'sub') = id)
with check (((select auth.jwt())->>'sub') = id);

alter policy contents_select_accessible on public.contents
using (
  visibility = 'public'
  or owner_user_id = ((select auth.jwt())->>'sub')
);

alter policy contents_insert_private_own on public.contents
with check (
  visibility = 'private'
  and owner_user_id = ((select auth.jwt())->>'sub')
);

alter policy contents_update_private_own on public.contents
using (
  visibility = 'private'
  and owner_user_id = ((select auth.jwt())->>'sub')
)
with check (
  visibility = 'private'
  and owner_user_id = ((select auth.jwt())->>'sub')
);

alter policy contents_delete_private_own on public.contents
using (
  visibility = 'private'
  and owner_user_id = ((select auth.jwt())->>'sub')
);

alter policy processing_jobs_select_own on public.processing_jobs
using (
  requested_by_user_id = ((select auth.jwt())->>'sub')
  or exists (
    select 1 from public.contents
    where contents.id = processing_jobs.content_id
      and contents.owner_user_id = ((select auth.jwt())->>'sub')
  )
);

alter policy blueprints_select_accessible on public.blueprints
using (
  exists (
    select 1 from public.contents
    where contents.id = blueprints.content_id
      and (
        contents.visibility = 'public'
        or contents.owner_user_id = ((select auth.jwt())->>'sub')
      )
  )
);

alter policy blueprint_segments_select_accessible on public.blueprint_segments
using (
  exists (
    select 1
    from public.blueprints
    join public.contents on contents.id = blueprints.content_id
    where blueprints.id = blueprint_segments.blueprint_id
      and (
        contents.visibility = 'public'
        or contents.owner_user_id = ((select auth.jwt())->>'sub')
      )
  )
);

alter policy user_content_states_own on public.user_content_states
using (((select auth.jwt())->>'sub') = user_id)
with check (((select auth.jwt())->>'sub') = user_id);

alter policy corpus_items_own on public.corpus_items
using (((select auth.jwt())->>'sub') = user_id)
with check (((select auth.jwt())->>'sub') = user_id);

alter policy speaking_sessions_own on public.speaking_sessions
using (((select auth.jwt())->>'sub') = user_id)
with check (((select auth.jwt())->>'sub') = user_id);

alter policy speaking_session_items_own on public.speaking_session_items
using (
  exists (
    select 1 from public.speaking_sessions
    where speaking_sessions.id = speaking_session_items.session_id
      and speaking_sessions.user_id = ((select auth.jwt())->>'sub')
  )
)
with check (
  exists (
    select 1 from public.speaking_sessions
    where speaking_sessions.id = speaking_session_items.session_id
      and speaking_sessions.user_id = ((select auth.jwt())->>'sub')
  )
);

alter policy speaking_turns_own on public.speaking_turns
using (
  exists (
    select 1 from public.speaking_sessions
    where speaking_sessions.id = speaking_turns.session_id
      and speaking_sessions.user_id = ((select auth.jwt())->>'sub')
  )
)
with check (
  exists (
    select 1 from public.speaking_sessions
    where speaking_sessions.id = speaking_turns.session_id
      and speaking_sessions.user_id = ((select auth.jwt())->>'sub')
  )
);

alter policy speaking_feedback_own on public.speaking_feedback
using (
  exists (
    select 1 from public.speaking_sessions
    where speaking_sessions.id = speaking_feedback.session_id
      and speaking_sessions.user_id = ((select auth.jwt())->>'sub')
  )
)
with check (
  exists (
    select 1 from public.speaking_sessions
    where speaking_sessions.id = speaking_feedback.session_id
      and speaking_sessions.user_id = ((select auth.jwt())->>'sub')
  )
);
