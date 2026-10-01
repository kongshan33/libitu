"""Timing-only recovery: fake persistence, no provider or paid-model calls."""

from collections import OrderedDict
from dataclasses import replace
import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.integrations import processing_queue
from app.integrations.supabase_repository import SupabaseRepository
from app.main import app
from app.schemas.captions import CaptionTrack
from app.schemas.blueprint import Blueprint
from app.schemas.content import ContentResolveResponse
from app.services import blueprint_service, caption_recovery, caption_source, content_resolver, job_service, store, transcript_formatter


CONTENT_ID = "22bbd214-5930-48a0-8cc4-576e5c184e26"
VIDEO_ID = "captiontest"


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    for name in ("contents", "content_transcripts", "content_caption_tracks", "blueprints", "jobs", "corpus_items"):
        monkeypatch.setattr(store, name, {})
    monkeypatch.setattr(blueprint_service, "_sentence_views", OrderedDict())
    monkeypatch.setattr(transcript_formatter, "get_punctuation_engine", lambda language=None: None)
    for module, name in ((content_resolver, "resolve_content"), (job_service, "create_or_resume_job")):
        monkeypatch.setattr(module, name, lambda *args, **kwargs: pytest.fail("Recovery must not resolve content or create a job"))


def track(text="We think about it.", start=1125):
    return CaptionTrack.model_validate({
        "version": "youtube-json3-v1", "video_id": VIDEO_ID, "language": "en", "kind": "asr",
        "events": [{"tStartMs": start, "dDurationMs": 1500, "segs": [
            {"utf8": (" " if index else "") + word, **({"tOffsetMs": index * 300} if index else {})}
            for index, word in enumerate(text.split())
        ]}],
    })


def real_intro_track():
    # Only the user's first five complete JSON3 events. The truncated following
    # event is deliberately absent; acAsrConf=0 is source data, not a quality gate.
    def segments(items):
        return [{"utf8": word, "acAsrConf": 0, **({"tOffsetMs": offset} if offset is not None else {})}
                for word, offset in items]
    return CaptionTrack.model_validate({
        "version": "youtube-json3-v1", "video_id": VIDEO_ID, "language": "en", "kind": "asr",
        "events": [
            {"tStartMs": 0, "dDurationMs": 902850, "id": 1},
            {"tStartMs": 440, "dDurationMs": 2959, "wWinId": 1, "segs": segments([
                ("Lisa", None), (" thank", 400), (" you", 520), (" so", 639), (" much", 840),
                (" for", 999), (" being", 1200), (" here", 1399),
            ])},
            {"tStartMs": 1949, "dDurationMs": 1450, "wWinId": 1, "aAppend": 1, "segs": [{"utf8": "\n"}]},
            {"tStartMs": 1959, "dDurationMs": 4320, "wWinId": 1, "segs": segments([
                ("tonight", None), (" with", 241), (" your", 361), (" husband", 521), (" we're", 920), (" honored", 1121),
            ])},
            {"tStartMs": 3389, "dDurationMs": 2890, "wWinId": 1, "aAppend": 1, "segs": [{"utf8": "\n"}]},
        ],
    })


def seed(text="0:01\tWe think about it."):
    content = ContentResolveResponse(content_id=CONTENT_ID, kind="youtube", normalized_key=f"youtube:{VIDEO_ID}",
                                     source_url=f"https://www.youtube.com/watch?v={VIDEO_ID}", title="Existing title", language="en", has_transcript=True)
    store.contents[CONTENT_ID] = content
    store.content_transcripts[CONTENT_ID] = text
    blueprint = blueprint_service.create_blueprint(content, text)
    store.jobs["untouched"] = {"status": "ready", "attempt_count": 3}
    store.corpus_items["untouched"] = {"text": "A personal snapshot"}
    return content, blueprint


def post(source, content_id=CONTENT_ID):
    return TestClient(app).post(f"/api/content/{content_id}/caption-timing?learner_level=B1", json={"caption_track": source.model_dump(exclude_none=True)})


def snapshot():
    return {
        "contents": dict(store.contents), "text": dict(store.content_transcripts), "tracks": dict(store.content_caption_tracks),
        "blueprints": {key: value.model_dump() for key, value in store.blueprints.items()},
        "jobs": dict(store.jobs), "corpus": dict(store.corpus_items), "views": dict(blueprint_service._sentence_views),
    }


def test_old_cache_upgrade_is_timing_only_and_idempotent():
    _, original = seed()
    before = snapshot()
    first = post(track())
    assert first.status_code == 200
    assert first.json()["status"] == "updated"
    blueprint = first.json()["blueprint"]
    assert blueprint["content_id"] == CONTENT_ID and blueprint["source_url"] == original.source_url
    assert blueprint["analysis_version"] == original.analysis_version and blueprint["summary"] == original.summary
    assert blueprint["segmentation_version"].startswith("sentence-v3-")
    assert len(blueprint["transcript"][0]["word_timings"]) == 4
    second = post(track())
    assert second.status_code == 200 and second.json()["status"] == "unchanged"
    assert second.json()["blueprint"] == blueprint
    after = snapshot()
    for field in ("contents", "text", "blueprints", "jobs", "corpus"):
        assert after[field] == before[field]


def test_real_intro_keeps_all_14_starts_and_filters_nontext_events():
    source = real_intro_track()
    seed(transcript_formatter.caption_track_to_text(source))
    parsed = transcript_formatter.parse_caption_track(source)
    assert len(parsed) == 2 and sum(len(row.word_timings) for row in parsed) == 14
    response = post(source)
    assert response.status_code == 200
    blueprint = response.json()["blueprint"]
    words = [word for row in blueprint["transcript"] for word in row["word_timings"]]
    assert len(words) == 14 and {word["source_event_index"] for word in words} == {1, 3}
    assert words[0]["start_ms"] == 440 and words[8]["start_ms"] == 1959
    assert words[7]["text"] == "here" and words[7]["end_ms"] == 1959
    assert words[-1]["end_source"] == "event_end_estimate"
    assert len(caption_recovery._usable_words(Blueprint.model_validate(blueprint))) == 13


@pytest.mark.parametrize("change,code", [
    ("old_text", "caption_text_mismatch"), ("blueprint_text", "caption_text_mismatch"),
    ("video", "caption_source_mismatch"), ("language", "caption_source_mismatch"),
    ("source_url", "caption_source_mismatch"), ("kind", "caption_source_mismatch"),
    ("old_version", "caption_blueprint_unavailable"), ("missing_blueprint", "caption_blueprint_unavailable"),
])
def test_conflicts_leave_all_stores_and_jobs_unchanged(change, code):
    _, blueprint = seed()
    source = track()
    if change == "old_text":
        store.content_transcripts[CONTENT_ID] = "We think against it."
    elif change == "blueprint_text":
        blueprint.transcript[0].parts = ["We think against it."]
    elif change in {"video", "language"}:
        source = source.model_copy(update={"video_id" if change == "video" else "language": "other" if change == "video" else "fr"})
    elif change == "source_url":
        blueprint.source_url = "https://www.youtube.com/watch?v=other"
    elif change == "kind":
        store.contents[CONTENT_ID] = store.contents[CONTENT_ID].model_copy(update={"kind": "article"})
    elif change == "old_version":
        blueprint.analysis_version = "obsolete"
    else:
        store.blueprints.clear()
    before = snapshot()
    response = post(source)
    assert response.status_code == 409 and response.json()["detail"]["code"] == code
    assert snapshot() == before


def test_missing_content_and_malformed_request_are_explicit():
    response = post(track())
    assert response.status_code == 404 and response.json()["detail"]["code"] == "content_not_found"
    response = TestClient(app).post(f"/api/content/{CONTENT_ID}/caption-timing", json={"caption_track": track().model_dump(), "reprocess": True})
    assert response.status_code == 422
    response = post(track(), content_id="target&select=private")
    assert response.status_code == 422


@pytest.mark.parametrize("variant", ["block", "snippet", "long_intervals"])
def test_no_usable_timing_is_not_reported_as_recovery(variant):
    seed("0:01\tHello. Goodbye.")
    source = track("Hello. Goodbye.")
    if variant == "snippet":
        source.version = "youtube-snippets-v1"
    elif variant == "block":
        source.events[0].segs = [source.events[0].segs[0].model_copy(update={"utf8": "Hello. Goodbye.", "tOffsetMs": None})]
    else:
        source.events[0].segs[1].tOffsetMs = 12000
        source.events[0].dDurationMs = 16000
    before = snapshot()
    response = post(source)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "caption_timing_unavailable"
    assert snapshot() == before


def test_same_normalized_fillers_case_and_punctuation_can_restore():
    seed("0:01\tUm, we THINK about it!")
    assert post(track()).status_code == 200


def test_changed_times_or_lost_coverage_cannot_overwrite_good_timing():
    seed()
    source = track()
    assert post(source).json()["status"] == "updated"
    original = store.content_caption_tracks[CONTENT_ID]
    shifted = track(start=4500)
    assert post(shifted).json()["status"] == "unchanged"
    shifted.events[0].segs[2].tOffsetMs = None
    assert post(shifted).json()["status"] == "unchanged"
    assert store.content_caption_tracks[CONTENT_ID] is original


class FakeRepository:
    def __init__(self, source, blueprint):
        self.source, self.blueprint = source, blueprint
        self.writes = 0
        self.fail = None

    def get_content(self, content_id):
        assert content_id == CONTENT_ID
        return self.source

    def get_blueprint(self, content_id, version):
        assert content_id == CONTENT_ID and version == self.blueprint.analysis_version
        return self.blueprint

    def save_caption_source(self, content_id, text, source):
        self.writes += 1
        if self.fail == "before":
            raise RuntimeError("provider secret must never appear")
        assert text == self.source.transcript_text
        self.source = replace(self.source, caption_track=source)
        if self.fail == "after":
            raise TimeoutError("provider secret must never appear")


def durable_setup(monkeypatch):
    content, blueprint = seed()
    repository = FakeRepository(processing_queue.QueuedContent(content, store.content_transcripts[CONTENT_ID]), blueprint)
    settings = SimpleNamespace(queue_is_configured=True, processing_mode="queue", analysis_version=get_settings().analysis_version)
    for module in (caption_recovery, caption_source, blueprint_service):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
        monkeypatch.setattr(module, "get_supabase_repository", lambda: repository)
    queued = {"value": repository.source}
    monkeypatch.setattr(processing_queue, "get_content", lambda _: queued["value"])
    monkeypatch.setattr(processing_queue, "get_blueprint", lambda *_: blueprint)
    monkeypatch.setattr(processing_queue, "save_content", lambda content, text, source: queued.update(value=processing_queue.QueuedContent(content, text, source)))
    return repository, queued


def test_cold_durable_source_upgrade_preserves_public_metadata_and_semantics(monkeypatch):
    repository, queued = durable_setup(monkeypatch)
    store.contents.clear()
    store.content_transcripts.clear()
    store.blueprints.clear()
    response = post(track())
    assert response.status_code == 200 and response.json()["status"] == "updated"
    assert repository.writes == 1 and queued["value"].caption_track == track()
    store.content_caption_tracks.clear()
    queued["value"] = replace(queued["value"], caption_track=None)
    view = blueprint_service.personalize_blueprint(repository.blueprint, None)
    assert len(view.transcript[0].word_timings) == 4
    assert post(track()).json()["status"] == "unchanged" and repository.writes == 1


@pytest.mark.parametrize("failure", ["before", "after"])
def test_uncertain_durable_failure_does_not_publish_or_claim_success(monkeypatch, failure):
    repository, queued = durable_setup(monkeypatch)
    repository.fail = failure
    before = snapshot()
    response = post(track())
    assert response.status_code == 503 and response.json()["detail"]["code"] == "caption_storage_unavailable"
    assert "provider secret" not in response.text
    assert snapshot() == before and queued["value"].caption_track is None
    repository.fail = None
    retry = post(track())
    assert retry.status_code == 200 and retry.json()["status"] == ("unchanged" if failure == "after" else "updated")
    assert queued["value"].caption_track == track()


def test_redis_publish_failure_can_recover_from_durable_then_retry(monkeypatch):
    repository, queued = durable_setup(monkeypatch)
    original_save = processing_queue.save_content
    monkeypatch.setattr(processing_queue, "save_content", lambda *_: (_ for _ in ()).throw(RuntimeError("queue failed")))
    response = post(track())
    assert response.status_code == 503 and repository.source.caption_track == track()
    assert not store.content_caption_tracks and queued["value"].caption_track is None
    assert caption_source.get_caption_track(CONTENT_ID) == track()
    monkeypatch.setattr(processing_queue, "save_content", original_save)
    retry = post(track())
    assert retry.status_code == 200 and retry.json()["status"] == "unchanged" and repository.writes == 1
    assert queued["value"].caption_track == track()


def test_durable_read_failure_fails_closed_without_local_memory_fallback(monkeypatch):
    repository, _ = durable_setup(monkeypatch)
    monkeypatch.setattr(repository, "get_content", lambda _: (_ for _ in ()).throw(TimeoutError("private")))
    before = snapshot()
    assert post(track()).status_code == 503
    assert snapshot() == before and repository.writes == 0


def test_processing_failure_is_explicit_before_any_persistence(monkeypatch):
    seed()
    before = snapshot()
    monkeypatch.setattr(caption_recovery, "build_caption_timing_view", lambda *_: (_ for _ in ()).throw(RuntimeError("source content must stay private")))
    response = post(track())
    assert response.status_code == 503 and response.json()["detail"]["code"] == "caption_processing_unavailable"
    assert "source content must stay private" not in response.text and snapshot() == before


def test_sound_keeps_exact_old_snapshot_ids_after_timing_recovery():
    _, original = seed()
    old_view = blueprint_service.personalize_blueprint(original, None)
    old_row = old_view.transcript[0]
    upgraded = post(track()).json()["blueprint"]
    new_id = upgraded["transcript"][0]["id"]
    assert new_id != old_row.id
    client = TestClient(app)
    for sentence_id in (old_row.id, new_id, original.transcript[0].id):
        result = client.get(f"/api/blueprints/{CONTENT_ID}/sentences/{sentence_id}/sound")
        assert result.status_code == 200
        assert result.json()["sentence_text"] == "We think about it."
    # Cold process still reconstructs only IDs from this stored semantic source.
    blueprint_service._sentence_views.clear()
    result = client.get(f"/api/blueprints/{CONTENT_ID}/sentences/{old_row.id}/sound")
    assert result.status_code == 200 and result.json()["sentence_text"] == "We think about it."
    assert client.get(f"/api/blueprints/{CONTENT_ID}/sentences/sentence-v2-0-4/sound").status_code == 404


def test_sound_old_snapshot_cannot_cross_changed_source_words():
    _, original = seed()
    old_id = blueprint_service.personalize_blueprint(original, None).transcript[0].id
    assert post(track()).status_code == 200
    store.content_caption_tracks[CONTENT_ID] = track("We think against it.")
    client = TestClient(app)
    assert client.get(f"/api/blueprints/{CONTENT_ID}/sentences/{old_id}/sound").status_code == 404


def test_optional_caption_read_obeys_durable_opt_out_and_failure(monkeypatch):
    repository, _ = durable_setup(monkeypatch)
    repository.source = replace(repository.source, caption_track=track())
    assert caption_source.get_caption_track(CONTENT_ID, include_durable=False) is None
    assert caption_source.get_caption_track(CONTENT_ID) == track()
    monkeypatch.setattr(repository, "get_content", lambda _: (_ for _ in ()).throw(TimeoutError("private")))
    assert caption_source.get_caption_track(CONTENT_ID) is None


def test_private_timing_write_uses_only_existing_payload_rpc():
    requests = []
    repository = SupabaseRepository("https://example.supabase.co", "test-secret")
    repository._client.close()
    repository._client = httpx.Client(base_url=repository._rest_url, transport=httpx.MockTransport(
        lambda request: requests.append(request) or httpx.Response(200, json=[])))
    try:
        repository.save_caption_source(CONTENT_ID, "0:01\tWe think about it.", track())
        assert len(requests) == 1 and requests[0].url.path.endswith("/rpc/upsert_content_payload")
        payload = json.loads(requests[0].content)
        assert payload["p_transcript_text"] == "0:01\tWe think about it."
        assert json.loads(payload["p_source_text"])["type"] == "libitu-caption-source-v1"
        assert payload["p_content_id"] == CONTENT_ID
    finally:
        repository._client.close()
