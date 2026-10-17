-- Allow independent learner processing while the Reference worker runs.
create or replace function public.claim_practice_analysis(p_token uuid,p_seconds integer)
returns setof public.practice_analyses language plpgsql security invoker set search_path='' as $$
begin
  update public.practice_analyses set state='failed',error_code='retry_exhausted',lease_token=null,lease_until=null,
    phase=case when analysis_version='practice-gated-v3' then 'finished' else phase end
    where state='processing' and lease_until<now() and attempts>=3;
  return query update public.practice_analyses set state='processing',attempts=attempts+1,lease_token=p_token,
    lease_until=now()+make_interval(secs=>least(greatest(p_seconds,30),900)),error_code=null
    where id=(select a.id from public.practice_analyses a join public.shadow_attempts s on s.id=a.id
      where (a.state='queued' or (a.state='processing' and a.lease_until<now())) and a.attempts<3
        and a.input_ready and a.input_cleaned_at is null and a.input_expires_at>now() and a.available_at<=now()
        and s.deleted_at is null
        and (
          -- Compute and checkpoint learner acoustics before waiting for reference preparation.
          (a.analysis_version='practice-gated-v3' and (a.word_check is null
            or a.learner_checkpoint is null or a.word_check->>'status'<>'reliable' or a.word_check->>'tier'='below_60'))
          or not exists(select 1 from public.acoustic_references r where r.id=a.reference_id
            and r.user_id=a.user_id and r.state in ('awaiting_upload','queued','processing') and r.expires_at>now())
        ) order by a.created_at for update of a skip locked limit 1) returning *;
end $$;

-- Existing service-role-only function grants are retained.
