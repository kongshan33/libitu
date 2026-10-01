-- Run against a migrated disposable database. Everything rolls back.
begin;
insert into public.profiles(id) values ('acoustic-queue-test');
insert into public.contents(id) values ('10000000-0000-0000-0000-000000000001');
insert into public.acoustic_references(id,user_id,content_id,segment_id,source_id,source_fingerprint,input_mode,input_sha256,analysis_version,snapshot,start_ms,end_ms,state,expires_at)
values ('20000000-0000-0000-0000-000000000001','acoustic-queue-test','10000000-0000-0000-0000-000000000001','segment','source',repeat('a',64),'file',repeat('b',64),'v1','{}',120000,121000,'queued',now()+interval '1 day');
do $$
declare r public.acoustic_references; n integer; accepted boolean;
begin
  select * into r from public.claim_acoustic_reference('30000000-0000-0000-0000-000000000001',30);
  if r.state <> 'processing' or r.attempts <> 1 then raise exception 'Claim failed'; end if;
  select count(*) into n from public.claim_acoustic_reference('30000000-0000-0000-0000-000000000002',30);
  if n <> 0 then raise exception 'Double claim'; end if;
  update public.acoustic_references set lease_until=now()-interval '1 second' where id=r.id;
  select * into r from public.claim_acoustic_reference('30000000-0000-0000-0000-000000000002',30);
  if r.attempts <> 2 then raise exception 'Expired lease not recovered'; end if;
  select public.update_acoustic_reference(r.id,'30000000-0000-0000-0000-000000000001','audio','{"sha256":"stale"}') into accepted;
  if accepted then raise exception 'Old worker write accepted'; end if;
  select public.update_acoustic_reference(r.id,'30000000-0000-0000-0000-000000000002','results','{"results":[{"sentence_id":"one"}]}') into accepted;
  if not accepted then raise exception 'Current worker write rejected'; end if;
  perform public.control_acoustic_reference(r.id,'someone-else','delete');
  if (select state from public.acoustic_references where id=r.id) <> 'processing' then raise exception 'Wrong owner deleted'; end if;
  perform public.control_acoustic_reference(r.id,'acoustic-queue-test','cancel');
  select public.update_acoustic_reference(r.id,'30000000-0000-0000-0000-000000000002','finish','{"state":"completed"}') into accepted;
  if accepted then raise exception 'Cancelled job revived'; end if;
  perform public.control_acoustic_reference(r.id,'acoustic-queue-test','retry');
  select * into r from public.claim_acoustic_reference('30000000-0000-0000-0000-000000000003',30);
  if r.state <> 'processing' or r.attempts <> 1 then raise exception 'Explicit retry failed'; end if;
  update public.acoustic_references set attempts=3,lease_until=now()-interval '1 second' where id=r.id;
  perform public.claim_acoustic_reference('30000000-0000-0000-0000-000000000004',30);
  if (select state from public.acoustic_references where id=r.id) <> 'failed' then raise exception 'Unbounded retry'; end if;
  perform public.control_acoustic_reference(r.id,'acoustic-queue-test','delete');
  perform public.control_acoustic_reference(r.id,'acoustic-queue-test','retry');
  select * into r from public.acoustic_references where id=r.id;
  if r.state <> 'deleted' or r.results <> '[]'::jsonb or r.snapshot <> '{}'::jsonb then raise exception 'Deletion failed'; end if;
  if has_table_privilege('anon','public.acoustic_references','SELECT') or has_table_privilege('authenticated','public.acoustic_references','SELECT') then raise exception 'Client table grants'; end if;
  if has_function_privilege('anon','public.claim_acoustic_reference(uuid,integer)','EXECUTE') then raise exception 'Client worker RPC grant'; end if;
end $$;
rollback;
