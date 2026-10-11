"""Caption-first transport/cache regressions; no YouTube, model or cloud writes."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.integrations import processing_queue
from app.integrations.supabase_repository import SupabaseRepository
from app.schemas.captions import CaptionTrack
from app.schemas.content import ContentKind, ContentResolveRequest, ContentResolveResponse
from app.schemas.job import JobCreateRequest
from app.services import blueprint_service, content_resolver, job_service, store
from app.services.caption_source import caption_fingerprint
from app.services.transcript_formatter import caption_track_to_text


@pytest.fixture
def isolated_sources(monkeypatch):
    for name in ("contents", "content_transcripts", "content_caption_tracks", "jobs", "blueprints"):
        monkeypatch.setattr(store, name, {})
    monkeypatch.setattr(blueprint_service, "_sentence_views", __import__("collections").OrderedDict())


def track(start=1_125, text="We think about it.", video_id="captiontest"):
    return CaptionTrack.model_validate({
        "version": "youtube-json3-v1", "video_id": video_id, "language": "en", "kind": "asr",
        "events": [{"tStartMs": start, "dDurationMs": 1_500, "segs": [
            {"utf8": (" " if index else "") + word, **({"tOffsetMs": index * 300} if index else {})}
            for index, word in enumerate(text.split())
        ]}],
    })


def resolve(caption_track=None, text=None):
    return content_resolver.resolve_content(ContentResolveRequest(
        kind=ContentKind.youtube, source_url="https://www.youtube.com/watch?v=captiontest",
        title="Caption source", language="en", transcript_text=text, caption_track=caption_track,
    ))


def test_rich_source_without_plain_text_reaches_both_stages(isolated_sources):
    source = track()
    client = TestClient(app)
    result = client.post("/api/content/resolve", json={
        "kind": "youtube", "source_url": "https://www.youtube.com/watch?v=captiontest",
        "language": "en", "caption_track": source.model_dump(exclude_none=True),
    })
    assert result.status_code == 200
    content_id = result.json()["content_id"]
    assert result.json()["has_transcript"] is True
    job = client.post("/api/jobs", json={"content_id": content_id})
    assert job.status_code == 200 and job.json()["status"] == "ready"
    blueprint = client.get(f"/api/blueprints/{content_id}").json()
    row = blueprint["transcript"][0]
    assert row["segmentation_version"].startswith("sentence-v3-")
    assert row["start_ms"] == 1_125
    assert row["timing_source"] == "caption_word_offsets"
    assert [word["start_ms"] for word in row["word_timings"]] == [1125, 1425, 1725, 2025]
    assert row["end_ms"] >= row["word_timings"][-1]["end_ms"]
    assert blueprint["caption_fingerprint"] == caption_fingerprint(source)
    segment = blueprint["segments"][0]
    assert segment["start_ms"] <= row["start_ms"] < row["end_ms"] <= segment["end_ms"]


def test_optional_track_cannot_cross_source_or_language(isolated_sources):
    client = TestClient(app)
    for updates in ({"source_url": "https://www.youtube.com/watch?v=another"}, {"language": "fr"}, {"kind": "article"}):
        response = client.post("/api/content/resolve", json={
            "kind": "youtube", "source_url": "https://www.youtube.com/watch?v=captiontest", "language": "en",
            "caption_track": track().model_dump(), **updates,
        })
        assert response.status_code == 422
    assert not store.content_caption_tracks


def test_timing_only_upgrade_reuses_analysis_and_immutable_legacy_cache(isolated_sources, monkeypatch):
    content = resolve(text="0:01\tWe think about it.")
    job = job_service.create_or_resume_job(JobCreateRequest(content_id=content.content_id))
    original = store.blueprints[content.content_id]
    snapshot = original.model_dump()
    source = track()
    resolve(source)
    assert store.jobs[job.id] is job
    assert store.blueprints[content.content_id] is original
    # No deterministic or paid analysis should be invoked by a timing-only resolve/read.
    monkeypatch.setattr(job_service, "create_blueprint", lambda *args: pytest.fail("unexpected reanalysis"))
    assert job_service.create_or_resume_job(JobCreateRequest(content_id=content.content_id)) is job
    first = blueprint_service.personalize_blueprint(original, None)
    second = blueprint_service.personalize_blueprint(original, "B1")
    assert first.transcript == second.transcript
    assert first.caption_fingerprint == caption_fingerprint(source)
    assert first.transcript[0].start_ms == 1125
    assert first.summary == original.summary
    assert original.model_dump() == snapshot
    # A different timing revision changes sentence identity/cache, not the analysis.
    resolve(track(start=1250))
    revised = blueprint_service.personalize_blueprint(original, None)
    assert revised.transcript[0].id != first.transcript[0].id
    assert revised.transcript[0].start_ms == 1250


def test_old_client_cannot_erase_matching_rich_caption_source(isolated_sources):
    source = track()
    content = resolve(source)
    resolve(text="0:01\tWe think about it.")
    assert store.content_caption_tracks[content.content_id] == source
    resolve(text="0:01\tThese are different words.")
    assert content.content_id not in store.content_caption_tracks


def test_mismatching_source_does_not_retime_existing_blueprint(isolated_sources):
    content = resolve(text="0:01\tThese are unrelated words.")
    job_service.create_or_resume_job(JobCreateRequest(content_id=content.content_id))
    original = blueprint_service.personalize_blueprint(store.blueprints[content.content_id], None)
    store.content_caption_tracks[content.content_id] = track()
    assert blueprint_service.personalize_blueprint(original, None).transcript == original.transcript


def test_queue_payload_roundtrips_raw_offsets_without_signed_urls(monkeypatch):
    values = {}
    monkeypatch.setattr(processing_queue, "_set_json", lambda key, value: values.update({key: value}))
    monkeypatch.setattr(processing_queue, "_get_json", values.get)
    content = ContentResolveResponse(content_id="queue-caption", kind="youtube", normalized_key="youtube:captiontest")
    source = track()
    processing_queue.save_content(content, caption_track_to_text(source), source)
    restored = processing_queue.get_content(content.content_id)
    assert restored.caption_track == source
    assert restored.caption_track.events[0].segs[0].tOffsetMs is None
    # Legacy content records remain valid.
    processing_queue.save_content(content, "0:01\tText.")
    assert processing_queue.get_content(content.content_id).caption_track is None


def test_private_source_envelope_roundtrip_uses_existing_rpc():
    requests = []
    saved = {}
    content = ContentResolveResponse(
        content_id="c6c716c7-df9c-4636-ac8d-ab62de218cb0", kind="youtube",
        normalized_key="youtube:captiontest", has_transcript=True,
    )
    source = track()

    def handler(request):
        body = json.loads(request.content) if request.content else None
        requests.append((request.method, request.url.path, body))
        if request.url.path.endswith("upsert_content_payload"):
            saved.update(body)
        if request.method == "GET":
            return httpx.Response(200, json=[{"id": content.content_id, "kind": "youtube", "normalized_key": content.normalized_key}])
        if request.url.path.endswith("get_content_payload"):
            return httpx.Response(200, json=[{"transcript_text": saved["p_transcript_text"], "source_text": saved["p_source_text"]}])
        return httpx.Response(200, json=[])

    repository = SupabaseRepository("https://example.supabase.co", "test-secret")
    repository._client.close()
    repository._client = httpx.Client(base_url=repository._rest_url, transport=httpx.MockTransport(handler))
    try:
        repository.save_content(content, caption_track_to_text(source), source)
        assert repository.get_content(content.content_id).caption_track == source
        assert requests[0][2]["metadata"] == {"has_transcript": True}
        assert "caption_track" not in requests[0][2]
        assert json.loads(saved["p_source_text"])["type"] == "libitu-caption-source-v1"
        # Older/corrupt envelopes preserve plain text, without fake word timings.
        saved["p_source_text"] = "An old article-like payload, not JSON."
        assert repository.get_content(content.content_id).caption_track is None
    finally:
        repository._client.close()


def test_persisted_ready_job_reuses_timing_but_not_different_words(isolated_sources, monkeypatch):
    content = resolve(text="0:01\tWe think about it.")
    job = job_service.create_or_resume_job(JobCreateRequest(content_id=content.content_id))
    original = store.blueprints[content.content_id]
    source = track()
    queued = processing_queue.QueuedContent(content, caption_track_to_text(source), source)
    monkeypatch.setattr(job_service.processing_queue, "get_content", lambda _: queued)
    monkeypatch.setattr(job_service.processing_queue, "get_blueprint", lambda *_: original)
    assert job_service._caption_source_changed(content.content_id, job.analysis_version) is False
    source = track(text="We discuss something else.")
    queued = processing_queue.QueuedContent(content, caption_track_to_text(source), source)
    assert job_service._caption_source_changed(content.content_id, job.analysis_version) is True


def test_cold_resolve_preserves_private_rich_source_for_an_old_client(isolated_sources, monkeypatch):
    source = track()
    content = resolve(source)
    old = processing_queue.QueuedContent(content, caption_track_to_text(source), source)
    store.content_transcripts.clear()
    store.content_caption_tracks.clear()
    writes = []

    class Repository:
        def get_content(self, content_id):
            assert content_id == content.content_id
            return old

        def save_content(self, *args):
            writes.append(args)

    monkeypatch.setattr(content_resolver, "get_supabase_repository", Repository)
    resolve(text="0:01\tWe think about it.")
    assert writes[0][2] == source
    assert store.content_caption_tracks[content.content_id] == source


@pytest.mark.parametrize("fetch_missing", [False, True])
def test_worker_keeps_caption_metadata_in_preview_and_final(monkeypatch, fetch_missing):
    from app.schemas.analysis import AnalysisLogicNode, BlueprintAnalysis
    from app.schemas.job import ProcessingJob, ProcessingStatus
    from app.workers import blueprint_worker as worker

    source = track()
    content = ContentResolveResponse(
        content_id="worker-rich", kind="youtube", normalized_key="youtube:captiontest", language="en",
    )
    job = ProcessingJob(id="worker-rich-job", content_id=content.content_id, status="pending", analysis_version="mvp-v9")
    jobs = {job.id: job}
    saved, previews, fetched = [], [], []
    queued = processing_queue.QueuedContent(content, None if fetch_missing else caption_track_to_text(source), None if fetch_missing else source)
    monkeypatch.setattr(worker.processing_queue, "get_job", jobs.get)
    monkeypatch.setattr(worker.processing_queue, "get_content", lambda _: queued)
    monkeypatch.setattr(worker.processing_queue, "acquire_lock", lambda _: True)
    monkeypatch.setattr(worker.processing_queue, "release_lock", lambda _: None)
    monkeypatch.setattr(worker.processing_queue, "save_blueprint", saved.append)
    monkeypatch.setattr(worker.processing_queue, "save_content", lambda *args: fetched.append(args))

    def save_job(value):
        jobs[value.id] = value
        if value.analysis_preview:
            previews.append(value.analysis_preview)

    def fetch(video_id, language):
        assert fetch_missing, "Browser-provided captions must not invoke a transcript provider."
        assert video_id == source.video_id and language == "en"
        return source

    def analyze(_content, text, on_progress):
        assert "We think about it." in text
        return BlueprintAnalysis(
            summary="A discussion.", chapters=["Discussion"],
            logic_flow=[AnalysisLogicNode(title="Discussion", subtitle="A discussion.", timestamp="0:01.125")],
            key_points=["We think about it."], scenario_suggestions=["Discuss an idea."],
        )

    monkeypatch.setattr(worker.processing_queue, "save_job", save_job)
    worker.process_job(job.id, analyzer=analyze, transcript_fetcher=fetch)
    assert jobs[job.id].status == ProcessingStatus.ready
    assert bool(fetched) == fetch_missing
    if fetched:
        assert fetched[0][2] == source
    assert saved[0].caption_fingerprint == caption_fingerprint(source)
    final = saved[0].transcript[0]
    first = previews[0].transcript_lines[0]
    assert final.id == first.id and final.word_timings == first.word_timings
    assert first.word_timings[2].text == "about"
    assert first.word_timings[2].start_ms == 1725


def test_final_blueprint_is_compressed_but_sse_stays_unbuffered(isolated_sources, monkeypatch):
    from app.routers import jobs as jobs_router
    from app.schemas.analysis import AnalysisTranscriptPreviewLine, BlueprintAnalysisPreview
    from app.schemas.job import ProcessingJob, ProcessingStatus
    from app.services.transcript_formatter import format_transcript

    source = track()
    content = resolve(source)
    job_service.create_or_resume_job(JobCreateRequest(content_id=content.content_id))
    client = TestClient(app)
    response = client.get(f"/api/blueprints/{content.content_id}", headers={"Accept-Encoding": "gzip"})
    assert len(response.content) > 2048
    assert response.headers["content-encoding"] == "gzip"
    assert int(response.headers["content-length"]) < len(response.content)
    assert "Accept-Encoding" in response.headers["vary"]

    row = format_transcript(caption_track_to_text(source), "en", caption_track=source)[0]
    processing = ProcessingJob(
        id="caption-stream", content_id=content.content_id, status="processing", analysis_version="mvp-v9",
        analysis_preview=BlueprintAnalysisPreview(transcript_lines=[
            AnalysisTranscriptPreviewLine(time=row.time, text=row.text, **row.metadata()),
        ]),
    )
    ready = processing.model_copy(update={"status": ProcessingStatus.ready})
    monkeypatch.setattr(jobs_router, "sleep", lambda _: None)
    for compact in (False, True, True):  # The last iteration simulates a fresh/reconnected stream.
        events = iter([processing, processing, ready])
        monkeypatch.setattr(jobs_router, "get_job", lambda _: next(events))
        response = client.get(f"/api/jobs/caption-stream/events?compact_word_timings={str(compact).lower()}")
        assert "content-encoding" not in response.headers
        frames = [json.loads(line.removeprefix("data: ")) for line in response.text.splitlines() if line.startswith("data: ")]
        assert len(frames) == 2
        first = frames[0]["analysis_preview"]["transcript_lines"][0]
        last = frames[1]["analysis_preview"]["transcript_lines"][0]
        assert first["word_timings"]
        assert ("word_timings" not in last) is compact
        assert last["timing_source"] == "caption_word_offsets"


def test_sse_compaction_never_hides_changed_or_cleared_word_evidence():
    from copy import deepcopy
    from app.routers.jobs import _compact_word_timings

    row = {"id": "stable-id", "segmentation_version": "sentence-v3-source", "source_token_start": 0,
        "source_token_end": 1, "text": "Hello.", "start_ms": 1000, "end_ms": 1500,
        "timing_source": "caption_word_offsets", "word_timings": [{"start_ms": 1000, "end_ms": 1500}]}
    sent = {}

    def compact(value):
        document = {"analysis_preview": {"transcript_lines": [deepcopy(value)]}}
        _compact_word_timings(document, sent)
        return document["analysis_preview"]["transcript_lines"][0]

    assert compact(row)["word_timings"]
    assert "word_timings" not in compact(row)
    assert compact({**row, "text": "Goodbye."})["word_timings"]
    assert compact({**row, "word_timings": None})["word_timings"] is None
    assert compact(row)["word_timings"]
    assert compact({**row, "word_timings": [{"start_ms": 1100, "end_ms": 1500}]})["word_timings"]


@pytest.fixture
def ready_optional_source(monkeypatch, isolated_sources):
    """A ready result and all external adapters replaced before fault injection."""
    from types import SimpleNamespace
    from app.schemas.blueprint import Blueprint, BlueprintSegment, TranscriptLine
    from app.schemas.job import ProcessingJob
    from app.services import caption_source

    settings = SimpleNamespace(queue_is_configured=True, analysis_version="caption-regression")
    blueprint = Blueprint(
        id="ready-blueprint", content_id="ready-content", analysis_version=settings.analysis_version,
        segmentation_version="sentence-v3-source", caption_fingerprint="existing-timing",
        title="Already available", summary="A usable analysis.", logic_flow=[],
        transcript=[TranscriptLine(time="0:01.125", parts=["We think about it."])],
        key_points=[], scenario_suggestions=[],
        segments=[BlueprintSegment(id="ready-segment", title="Practice", summary="A usable segment.", start_ms=1125, end_ms=2625)],
    )
    ready = ProcessingJob(
        id="ready-job", content_id=blueprint.content_id, analysis_version=settings.analysis_version,
        status="ready", blueprint_id=blueprint.id,
    )
    queued = processing_queue.QueuedContent(ContentResolveResponse(
        content_id=blueprint.content_id, kind="youtube", normalized_key="youtube:captiontest", language="en",
    ), caption_track_to_text(track()), track())
    for module in (caption_source, blueprint_service, job_service):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
        monkeypatch.setattr(module, "get_supabase_repository", lambda: None)
    monkeypatch.setattr(processing_queue, "get_content", lambda _: queued)
    monkeypatch.setattr(processing_queue, "get_blueprint", lambda *_: blueprint)
    monkeypatch.setattr(processing_queue, "find_job", lambda *_: ready)
    monkeypatch.setattr(processing_queue, "get_job", lambda _: ready)
    return SimpleNamespace(blueprint=blueprint, job=ready, queued=queued, settings=settings)


@pytest.mark.parametrize("failure", ["redis", "durable", "invalid_track"])
def test_ready_blueprint_survives_optional_timing_read_failure(ready_optional_source, monkeypatch, caplog, failure):
    from types import SimpleNamespace
    from app.services import caption_source

    fixture = ready_optional_source
    original = fixture.blueprint.model_dump()

    def unavailable(*_args):
        raise TimeoutError("fixture-secret-optional-timing")

    if failure == "redis":
        monkeypatch.setattr(processing_queue, "get_content", unavailable)
    elif failure == "durable":
        # A legacy-but-versioned cached result probes the durable timing upgrade.
        fixture.blueprint.caption_fingerprint = None
        original = fixture.blueprint.model_dump()
        monkeypatch.setattr(processing_queue, "get_content", lambda _: None)
        monkeypatch.setattr(caption_source, "get_supabase_repository", lambda: SimpleNamespace(get_content=unavailable))
    else:
        malformed = {
            "content": fixture.queued.content.model_dump(), "transcript_text": fixture.queued.transcript_text,
            "caption_track": {"version": "youtube-json3-v1", "video_id": "captiontest", "events": [{"tStartMs": "invalid"}]},
        }
        # Exercise the real source schema: a corrupt optional field is not a
        # reason to discard the separately cached, already validated blueprint.
        def decode_content(_content_id):
            return processing_queue.QueuedContent(
                content=ContentResolveResponse.model_validate(malformed["content"]),
                transcript_text=malformed["transcript_text"],
                caption_track=CaptionTrack.model_validate(malformed["caption_track"]),
            )
        monkeypatch.setattr(processing_queue, "get_content", decode_content)

    response = TestClient(app).get(f"/api/blueprints/{fixture.blueprint.content_id}")
    assert response.status_code == 200
    assert response.json()["summary"] == original["summary"]
    assert response.json()["transcript"] == original["transcript"]
    assert fixture.blueprint.model_dump() == original
    assert "Optional caption timing read failed:" in caplog.text
    assert "fixture-secret-optional-timing" not in caplog.text


@pytest.mark.parametrize("ready_location", ["redis", "durable"])
@pytest.mark.parametrize("failure", ["content", "source_blueprint", "durable_blueprint"])
def test_ready_job_survives_optional_source_probe_without_requeue(ready_optional_source, monkeypatch, caplog, ready_location, failure):
    from types import SimpleNamespace

    fixture = ready_optional_source
    cached_jobs = []

    def unavailable(*_args):
        raise TimeoutError("fixture-secret-source-probe")

    def forbidden(*_args):
        pytest.fail("An optional source probe must not restart or requeue a ready analysis.")

    repository = SimpleNamespace(find_job=lambda *_: fixture.job, get_blueprint=lambda *_: fixture.blueprint)
    monkeypatch.setattr(job_service, "get_supabase_repository", lambda: repository)
    monkeypatch.setattr(processing_queue, "find_job", lambda *_: fixture.job if ready_location == "redis" else None)
    monkeypatch.setattr(processing_queue, "save_job", cached_jobs.append)
    monkeypatch.setattr(processing_queue, "enqueue", forbidden)
    monkeypatch.setattr(job_service, "_resume_job", forbidden)
    repository.compare_and_swap_job = forbidden
    if failure == "content":
        monkeypatch.setattr(processing_queue, "get_content", unavailable)
    elif failure == "source_blueprint":
        monkeypatch.setattr(processing_queue, "get_blueprint", unavailable)
    else:
        monkeypatch.setattr(processing_queue, "get_blueprint", lambda *_: None)
        repository.get_blueprint = unavailable

    result = job_service.create_or_resume_job(JobCreateRequest(content_id=fixture.blueprint.content_id))
    assert result is fixture.job
    assert result.status == "ready" and result.blueprint_id == fixture.blueprint.id
    assert cached_jobs == [fixture.job]  # Durable state now refreshes either hot or cold cache.
    assert "Optional caption source comparison failed: TimeoutError" in caplog.text
    assert "fixture-secret-source-probe" not in caplog.text


@pytest.mark.parametrize("resource", ["blueprint", "job"])
def test_required_result_reads_still_surface_failures(ready_optional_source, monkeypatch, resource):
    def unavailable(*_args):
        raise TimeoutError("Required result cache is unavailable.")

    if resource == "blueprint":
        monkeypatch.setattr(processing_queue, "get_blueprint", unavailable)
        read = lambda: blueprint_service.get_blueprint(ready_optional_source.blueprint.content_id)
    else:
        monkeypatch.setattr(processing_queue, "get_job", unavailable)
        read = lambda: job_service.get_job(ready_optional_source.job.id)
    with pytest.raises(TimeoutError, match="Required result cache"):
        read()
