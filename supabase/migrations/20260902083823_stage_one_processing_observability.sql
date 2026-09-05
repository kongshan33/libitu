alter table public.processing_jobs
add column processing_stage text not null default 'queued',
add column queued_at timestamptz,
add column stage_timings_ms jsonb not null default '{}'::jsonb;

update public.processing_jobs
set queued_at = created_at
where queued_at is null;

alter table public.processing_jobs
alter column queued_at set default now(),
alter column queued_at set not null,
add constraint processing_jobs_stage_valid check (
  processing_stage in (
    'queued',
    'loading_content',
    'fetching_transcript',
    'analyzing',
    'building_blueprint',
    'persisting',
    'completed',
    'failed'
  )
),
add constraint processing_jobs_stage_timings_object check (
  jsonb_typeof(stage_timings_ms) = 'object'
);
