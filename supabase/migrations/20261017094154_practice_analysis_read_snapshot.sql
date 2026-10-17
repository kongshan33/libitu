-- One coherent, service-only status snapshot; never select private raw checkpoints.
create function public.practice_analysis_read_snapshot(p_owner text,p_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object(
    'attempt',jsonb_build_object('id',s.id,'user_id',s.user_id,'content_id',s.content_id,
      'sentence_id',s.sentence_id,'sentence_text',s.sentence_text,'start_ms',s.start_ms,'end_ms',s.end_ms,
      'recognition_feedback',s.recognition_feedback),
    'analysis',case when a.id is not null then jsonb_build_object(
      'id',a.id,'reference_id',a.reference_id,'state',a.state,'phase',a.phase,'analysis_version',a.analysis_version,
      'word_check',a.word_check,'coarse_checkpoint',a.coarse_checkpoint,'result',a.result,
      'error_code',a.error_code,'created_at',a.created_at,'input_cleaned_at',a.input_cleaned_at,
      'input_expires_at',a.input_expires_at,'snapshot',jsonb_build_object('engine',a.snapshot->'engine')) end,
    'reference',reference.data)
  from public.shadow_attempts s
  left join public.practice_analyses a on a.id=s.id and a.user_id=p_owner
  left join lateral (
    select jsonb_build_object(
      'id',r.id,'user_id',r.user_id,'content_id',r.content_id,'state',r.state,'expires_at',r.expires_at,
      'audio_ready',r.audio_ready,'input_mode',r.input_mode,'source_id',r.source_id,
      'source_fingerprint',r.source_fingerprint,'start_ms',r.start_ms,'end_ms',r.end_ms,
      'snapshot',jsonb_build_object('engine',r.snapshot->'engine','source_kind',r.snapshot->'source_kind',
        'consent_version',r.snapshot->'consent_version','sentences',
        coalesce((select jsonb_agg(sentence) from jsonb_array_elements(r.snapshot->'sentences') sentence
          where sentence->>'id'=s.sentence_id),'[]'::jsonb)),
      'results',coalesce((select jsonb_agg(jsonb_build_object('sentence_id',item->'sentence_id','coarse',item->'coarse'))
        from jsonb_array_elements(r.results) item where item->>'sentence_id'=s.sentence_id),'[]'::jsonb)
    ) as data
    from public.acoustic_references r
    join public.contents c on c.id=r.content_id and (c.visibility='public' or c.owner_user_id=p_owner)
    where r.id=a.reference_id and r.user_id=p_owner and r.content_id=s.content_id
      and r.state<>'deleted' and r.expires_at>statement_timestamp()
  ) reference on a.state='queued' or a.result is not null or a.coarse_checkpoint is not null
  where s.id=p_id and s.user_id=p_owner and s.deleted_at is null;
$$;
revoke all on function public.practice_analysis_read_snapshot(text,uuid) from public,anon,authenticated;
grant execute on function public.practice_analysis_read_snapshot(text,uuid) to service_role;
