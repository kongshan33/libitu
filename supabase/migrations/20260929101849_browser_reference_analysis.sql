-- Browser captures reuse private upload assets and JSON snapshots. No new client privileges.
create or replace function public.claim_practice_analysis(p_token uuid,p_seconds integer)
returns setof public.practice_analyses language plpgsql security invoker set search_path='' as $$
begin
  update public.practice_analyses set state='failed',error_code='retry_exhausted',lease_token=null,lease_until=null
    where state='processing' and lease_until<now() and attempts>=3;
  return query update public.practice_analyses set state='processing',attempts=attempts+1,lease_token=p_token,
    lease_until=now()+make_interval(secs=>least(greatest(p_seconds,30),900)),error_code=null
    where id=(select a.id from public.practice_analyses a join public.shadow_attempts s on s.id=a.id
      where (a.state='queued' or (a.state='processing' and a.lease_until<now())) and a.attempts<3
        and a.input_ready and a.input_cleaned_at is null and a.input_expires_at>now() and a.available_at<=now()
        and s.deleted_at is null
        -- Waiting for a reference must not consume the learner's three worker attempts.
        and not exists(select 1 from public.acoustic_references r where r.id=a.reference_id
          and r.user_id=a.user_id and r.state in ('awaiting_upload','queued','processing') and r.expires_at>now())
        order by a.created_at for update of a skip locked limit 1) returning *;
end $$;

