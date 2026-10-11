"""Opt-in isolated PostgreSQL + Redis/Lua contract check; never uses app credentials.

Run with a disposable local PostgreSQL DSN and temporary fakeredis[lua]/psycopg
dependencies. The generated table is removed in finally; no migrations are applied.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from types import SimpleNamespace
from uuid import uuid4

import fakeredis
import httpx
import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb

from app.integrations import processing_queue
from app.integrations.supabase_repository import SupabaseRepository
from app.schemas.job import ProcessingJob, ProcessingStatus
from app.services.job_service import _resume_job


def check_redis() -> None:
    redis = fakeredis.FakeRedis(decode_responses=True)
    class RedisAdapter:
        def eval(self, script, keys, args):
            return redis.eval(script, len(keys), *keys, *args)
        def get(self, key):
            return redis.get(key)
    processing_queue._redis = lambda: RedisAdapter()
    processing_queue.get_settings = lambda: SimpleNamespace(processing_state_ttl_seconds=60)
    failed = ProcessingJob(id="job", content_id="content", analysis_version="v1", status="failed", attempt_count=2)
    processing_queue.save_job(failed)
    retry = _resume_job(failed)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: processing_queue.compare_and_swap_job(failed, retry), range(32)))
    assert sum(result is not None for result in results) == 1
    processing = retry.model_copy(update={"status": ProcessingStatus.processing})
    processing_queue.save_job(processing)
    processing_queue.save_job(retry)  # delayed pending publisher
    assert processing_queue.get_job("job").status == "processing"
    failed_again = processing.model_copy(update={"status": ProcessingStatus.failed})
    processing_queue.save_job(failed_again)
    assert processing_queue.compare_and_swap_job(failed, retry) is None
    processing_queue.save_job(processing)  # late worker preview
    processing_queue.save_job(failed)  # stale cache hydration
    assert processing_queue.get_job("job").attempt_count == 3
    assert processing_queue.get_job("job").status == "failed"
    assert processing_queue.find_job("content", "v1").id == "job"
    print("PASS Redis Lua: 32-way CAS, fast second failure, delayed progress/cache publishers")


def check_postgres(dsn: str) -> None:
    table = sql.Identifier("libitu_retry_test_" + uuid4().hex)
    def connect():
        return psycopg.connect(dsn, autocommit=True)
    with connect() as conn:
        conn.execute(sql.SQL("CREATE TABLE {} (id text PRIMARY KEY, content_id text, analysis_version text, status text, attempt_count integer, payload jsonb, UNIQUE(content_id, analysis_version))").format(table))
    def transport(request):
        params = dict(request.url.params)
        with connect() as conn:
            if request.method == "POST":
                body = json.loads(request.content)
                try:
                    row = conn.execute(sql.SQL("INSERT INTO {} VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT(content_id,analysis_version) DO NOTHING RETURNING payload").format(table),
                        [body["id"], body["content_id"], body["analysis_version"], body["status"], body["attempt_count"], Jsonb(body)]).fetchone()
                except psycopg.errors.UniqueViolation:
                    return httpx.Response(409, json={"code": "23505", "message": "Unique conflict"})
            else:
                clauses, values = [], []
                for key in ("id", "content_id", "analysis_version", "status", "attempt_count"):
                    if key in params:
                        assert params[key].startswith("eq.")
                        clauses.append(sql.SQL("{} = %s").format(sql.Identifier(key)))
                        values.append(params[key][3:])
                where = sql.SQL(" AND ").join(clauses)
                if request.method == "PATCH":
                    body = json.loads(request.content)
                    row = conn.execute(sql.SQL("UPDATE {} SET status=%s, attempt_count=%s, payload=%s WHERE {} RETURNING payload").format(table, where),
                        [body["status"], body["attempt_count"], Jsonb(body), *values]).fetchone()
                else:
                    row = conn.execute(sql.SQL("SELECT payload FROM {} WHERE {}").format(table, where), values).fetchone()
        return httpx.Response(200, json=[row[0]] if row else [])
    repo = SupabaseRepository("https://fixture.invalid", "not-a-secret")
    repo._client.close()
    repo._client = httpx.Client(base_url=repo._rest_url, transport=httpx.MockTransport(transport))
    try:
        failed = ProcessingJob(id="job", content_id="content", analysis_version="v1", status="failed", attempt_count=2)
        with ThreadPoolExecutor(max_workers=8) as pool:
            created = list(pool.map(lambda _: repo.create_job_once(failed), range(32)))
        assert {job.id for job in created} == {"job"}
        retry = _resume_job(failed)
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: repo.compare_and_swap_job(failed, retry), range(32)))
        assert sum(result is not None for result in results) == 1
        again = retry.model_copy(update={"status": ProcessingStatus.failed})
        assert repo.compare_and_swap_job(retry, again)
        assert repo.compare_and_swap_job(failed, retry) is None
        assert repo.get_job("job").attempt_count == 3
        print("PASS PostgreSQL: repository request predicates, 32-way create/CAS, late retry after a second failure")
    finally:
        repo._client.close()
        with connect() as conn:
            conn.execute(sql.SQL("DROP TABLE {}").format(table))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dsn", required=True, help="Explicit disposable local PostgreSQL database")
    args = parser.parse_args()
    check_redis()
    check_postgres(args.dsn)
