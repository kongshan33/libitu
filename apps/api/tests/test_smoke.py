from uuid import uuid4

from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, require_user
from app.integrations.ark_analysis import AnalysisProviderError
from app.main import app
from app.routers import health, jobs as jobs_router
from app.schemas.analysis import AnalysisTranscriptPreviewLine, BlueprintAnalysisPreview
from app.schemas.corpus import CorpusSelectionAnalysis
from app.schemas.job import ProcessingJob, ProcessingStage, ProcessingStatus
from app.services import corpus_selection_service, corpus_service


client = TestClient(app)


def selection_analysis_result(
    selected_text: str,
    *,
    recommended_text: str | None = None,
    completeness: str = "complete",
) -> CorpusSelectionAnalysis:
    recommended_text = recommended_text or selected_text
    return CorpusSelectionAnalysis.model_validate(
        {
            "analysis_source": "ai",
            "selection_type": "phrase" if completeness == "complete" else "sentence",
            "completeness": completeness,
            "selected_text": selected_text,
            "recommended_text": recommended_text,
            "recommendation_reason": "所选内容本身是可独立学习的表达。",
            "fields": {
                "kind": "chunk",
                "tags": ["softening"],
                "level": "B2",
                "register": "professional",
            },
            "note_placeholder": "可选笔记",
            "explanation": {
                "pronunciation": {
                    "ipa": "/test/",
                    "connected_speech": "关注句子重音。",
                    "audio_text": selected_text,
                },
                "meaning": "结合上下文，表示我想不明白或无法理解。",
                "pragmatic_function": "委婉插入说话人的困惑和评价。",
                "similar_expressions": ["that I cannot explain — 更直接"],
                "examples": [
                    {
                        "english": "For reasons that escape me, they declined.",
                        "chinese": "不知为何，他们拒绝了。",
                        "typical": True,
                    }
                ],
                "usage_chips": ["书面语", "委婉困惑"],
            },
            "syntax_analysis": {
                "sentence_type": "简单句，含插入语和同位语",
                "main_clause": "Hammurabi's code resides in the Louvre Museum in Paris.",
                "structure_breakdown": ["that escapes me 是修饰 reason 的定语从句。"],
                "logic_relations": ["话题开启 → 主观疑惑 → 核心事实"],
                "information_hierarchy": ["焦点信息位于句末。"],
                "style_features": ["书面随笔风格，略带反讽。"],
                "usage_scenarios": ["适合随笔中夹带个人评论。"],
                "grammar_points": ["escape somebody 表示不为某人所理解。"],
                "wording_notes": ["reside 用于文物时带拟人色彩。"],
                "reusable_patterns": [
                    {
                        "template": "I was wondering if [CLAUSE]",
                        "slots": {"CLAUSE": "请求内容"},
                        "rationale": "用于委婉提出请求。",
                    }
                ],
                "translations": [
                    {
                        "label": "保留原文风格",
                        "text": "出于某种我百思不得其解的缘由。",
                        "recommended": True,
                    }
                ],
                "translation_notes": ["escapes me 不按字面译为逃离我。"],
                "background_context": None,
                "evidence": [recommended_text],
            },
        }
    )


def test_content_job_blueprint_flow() -> None:
    content_response = client.post(
        "/api/content/resolve",
        json={
            "kind": "youtube",
            "source_url": "https://www.youtube.com/watch?v=abc123",
            "title": "Demo",
            "transcript_text": "0:01\tI think this is the opening.\n0:05\tThe point is that every video should be different.",
            "language": "en",
        },
    )
    assert content_response.status_code == 200
    content = content_response.json()
    assert content["has_transcript"] is True
    assert content["language"] == "en"
    content_id = content["content_id"]

    job_response = client.post("/api/jobs", json={"content_id": content_id})
    assert job_response.status_code == 200
    assert job_response.json()["status"] == "ready"
    job_id = job_response.json()["id"]

    poll_response = client.get(f"/api/jobs/{job_id}")
    assert poll_response.status_code == 200
    assert poll_response.json()["content_id"] == content_id

    blueprint_response = client.get(f"/api/blueprints/{content_id}")
    assert blueprint_response.status_code == 200
    blueprint = blueprint_response.json()
    assert blueprint["content_id"] == content_id
    assert blueprint["title"] == "Demo"
    assert blueprint["source_url"] == "https://www.youtube.com/watch?v=abc123"
    assert blueprint["transcript"][0]["time"] == "0:01"
    assert "this is the opening" in blueprint["transcript"][0]["parts"][-1]
    assert blueprint["logic_flow"]
    assert blueprint["chapters"]
    assert blueprint["transcript"]
    assert blueprint["corpus_items"]


def test_analysis_version_is_server_owned() -> None:
    response = client.post(
        "/api/jobs",
        json={"content_id": "content-id", "analysis_version": "client-version"},
    )

    assert response.status_code == 422


def test_corpus_selection_analysis_expands_fragments(monkeypatch) -> None:
    monkeypatch.setattr(
        corpus_selection_service,
        "generate_selection_analysis",
        lambda payload: selection_analysis_result(
            payload.selected_text,
            recommended_text="I was wondering if you could take a quick look.",
            completeness="needs_expansion",
        ),
    )
    response = client.post(
        "/api/corpus/analyze-selection",
        json={
            "selected_text": "wondering if you could",
            "current_sentence": "I was wondering if you could take a quick look.",
            "context_before": "There is one detail I am unsure about.",
            "context_after": "No rush if today is packed.",
            "timestamp": "0:12",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["analysis_source"] == "ai"
    assert payload["completeness"] == "needs_expansion"
    assert payload["recommended_text"] == "I was wondering if you could take a quick look."
    assert payload["fields"]["register"] == "professional"
    assert payload["syntax_analysis"]["reusable_patterns"][0]["template"] == "I was wondering if [CLAUSE]"


def test_corpus_selection_analysis_keeps_a_complete_short_phrase(monkeypatch) -> None:
    monkeypatch.setattr(
        corpus_selection_service,
        "generate_selection_analysis",
        lambda payload: selection_analysis_result(payload.selected_text),
    )

    response = client.post(
        "/api/corpus/analyze-selection",
        json={
            "selected_text": "that escapes me",
            "current_sentence": "Now, for some reason that escapes me, the stele resides in the Louvre.",
            "context_before": "The artifact was taken from ancient Babylon.",
            "context_after": "That location still surprises the author.",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["selection_type"] == "phrase"
    assert payload["completeness"] == "complete"
    assert payload["recommended_text"] == "that escapes me"
    assert "无法理解" in payload["explanation"]["meaning"]
    assert payload["syntax_analysis"]["information_hierarchy"]
    assert payload["syntax_analysis"]["translations"][0]["recommended"] is True


def test_corpus_selection_analysis_marks_provider_fallback(monkeypatch) -> None:
    def unavailable(_payload) -> CorpusSelectionAnalysis:
        raise AnalysisProviderError("Doubao is not configured.")

    monkeypatch.setattr(
        corpus_selection_service,
        "generate_selection_analysis",
        unavailable,
    )

    response = client.post(
        "/api/corpus/analyze-selection",
        json={
            "selected_text": "that escapes me",
            "current_sentence": "For some reason that escapes me, it remains there.",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["analysis_source"] == "fallback"
    assert payload["recommended_text"] == "that escapes me"
    assert "无法可靠解释" in payload["explanation"]["meaning"]


def test_job_events_stream_analysis_previews_until_ready(monkeypatch) -> None:
    processing = ProcessingJob(
        id="stream-job",
        content_id="stream-content",
        status=ProcessingStatus.processing,
        analysis_version="mvp-v6",
        processing_stage=ProcessingStage.analyzing,
        analysis_preview=BlueprintAnalysisPreview(
            output_chars=1200,
            summary="The summary is ready.",
            transcript_lines=[
                AnalysisTranscriptPreviewLine(time="0:01", text="A complete subtitle.")
            ],
        ),
    )
    ready = processing.model_copy(
        update={
            "status": ProcessingStatus.ready,
            "processing_stage": ProcessingStage.completed,
            "blueprint_id": "stream-blueprint",
            "analysis_preview": None,
        }
    )
    jobs = iter([processing, processing, ready])
    monkeypatch.setattr(jobs_router, "get_job", lambda _job_id: next(jobs))
    monkeypatch.setattr(jobs_router, "sleep", lambda _seconds: None)

    response = client.get("/api/jobs/stream-job/events")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.text.count("event: job") == 2
    assert '"summary":"The summary is ready."' in response.text
    assert '"text":"A complete subtitle."' in response.text
    assert '"status":"ready"' in response.text


def test_inline_readiness_does_not_require_worker() -> None:
    response = client.get("/health/ready")

    assert response.status_code == 200
    assert response.json()["worker"] == "disabled"


def test_queue_readiness_reports_missing_worker(monkeypatch) -> None:
    monkeypatch.setattr(
        health,
        "get_settings",
        lambda: type(
            "Settings",
            (),
            {
                "processing_mode": "queue",
                "upstash_is_configured": True,
                "analysis_version": "mvp-v6",
                "ark_model": "doubao-seed-2-1-lite-260915",
            },
        )(),
    )
    monkeypatch.setattr(health.processing_queue, "get_worker_heartbeat", lambda: None)

    response = client.get("/health/ready")

    assert response.status_code == 503
    assert response.json()["detail"]["worker"] == "missing"


def test_queue_readiness_reports_missing_configuration(monkeypatch) -> None:
    monkeypatch.setattr(
        health,
        "get_settings",
        lambda: type(
            "Settings",
            (),
            {"processing_mode": "queue", "upstash_is_configured": False},
        )(),
    )

    response = client.get("/health/ready")

    assert response.status_code == 503
    assert response.json()["detail"]["worker"] == "unconfigured"


def test_queue_readiness_reports_live_worker(monkeypatch) -> None:
    monkeypatch.setattr(
        health,
        "get_settings",
        lambda: type(
            "Settings",
            (),
            {
                "processing_mode": "queue",
                "upstash_is_configured": True,
                "analysis_version": "mvp-v6",
                "ark_model": "doubao-seed-2-1-lite-260915",
            },
        )(),
    )
    monkeypatch.setattr(
        health.processing_queue,
        "get_worker_heartbeat",
        lambda: {
            "timestamp": "2026-09-02T08:30:00+00:00",
            "analysis_version": "mvp-v6",
            "model": "doubao-seed-2-1-lite-260915",
        },
    )

    response = client.get("/health/ready")

    assert response.status_code == 200
    assert response.json()["worker"] == "ready"


def test_queue_readiness_reports_stale_worker(monkeypatch) -> None:
    monkeypatch.setattr(
        health,
        "get_settings",
        lambda: type(
            "Settings",
            (),
            {
                "processing_mode": "queue",
                "upstash_is_configured": True,
                "analysis_version": "mvp-v5",
                "ark_model": "doubao-seed-2-1-lite-260915",
            },
        )(),
    )
    monkeypatch.setattr(
        health.processing_queue,
        "get_worker_heartbeat",
        lambda: {
            "timestamp": "2026-09-02T08:30:00+00:00",
            "analysis_version": "mvp-v2",
            "model": "doubao-other-model",
        },
    )

    response = client.get("/health/ready")

    assert response.status_code == 503
    assert response.json()["detail"]["worker"] == "stale"


def test_blueprints_use_each_video_transcript_and_reject_missing_captions() -> None:
    second_content = client.post(
        "/api/content/resolve",
        json={
            "kind": "youtube",
            "source_url": "https://www.youtube.com/watch?v=second-video",
            "title": "A different video",
            "transcript_text": "0:12\tTo be fair, this transcript belongs only to the second video.",
            "language": "en",
        },
    ).json()
    second_job = client.post("/api/jobs", json={"content_id": second_content["content_id"]}).json()
    assert second_job["status"] == "ready"

    second_blueprint = client.get(f"/api/blueprints/{second_content['content_id']}").json()
    assert second_blueprint["title"] == "A different video"
    assert "second video" in second_blueprint["summary"]
    assert second_blueprint["transcript"][0]["time"] == "0:12"
    assert second_blueprint["corpus_items"][0]["text"].startswith('"to be fair"')

    missing_content = client.post(
        "/api/content/resolve",
        json={
            "kind": "youtube",
            "source_url": "https://www.youtube.com/watch?v=no-captions",
            "title": "No captions",
        },
    ).json()
    missing_job = client.post("/api/jobs", json={"content_id": missing_content["content_id"]}).json()
    assert missing_job["status"] == "failed"
    assert "No transcript" in missing_job["error_message"]


def test_corpus_and_speaking_flow() -> None:
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="user_test_one")
    try:
        corpus_response = client.post(
            "/api/corpus",
            json={"kind": "chunk", "text": "to be fair", "tags": ["acknowledging"]},
        )
        assert corpus_response.status_code == 201
        assert corpus_response.json()["user_id"] == "user_test_one"

        session_response = client.post(
            "/api/speaking/sessions",
            json={
                "client_id": str(uuid4()), "scenario_type": "workplace", "goal": "Align with a stakeholder",
                "corpus_item_ids": [corpus_response.json()["id"]],
            },
        )
        assert session_response.status_code == 201
        assert session_response.json()["user_id"] == "user_test_one"
        session_id = session_response.json()["id"]
        assert session_response.json()["items"][0]["text"] == "to be fair"
        assert client.get(f"/api/speaking/sessions/{session_id}").json() == session_response.json()

        turn_response = client.post(
            f"/api/speaking/sessions/{session_id}/turns",
            json={"user_message": "I think there is a real tension here."},
        )
        assert turn_response.status_code == 200
        assert turn_response.json()["session_id"] == session_id
    finally:
        app.dependency_overrides.clear()


def test_saved_corpus_analysis_is_generated_once_and_persisted(monkeypatch) -> None:
    calls = 0

    def analyze(payload):
        nonlocal calls
        calls += 1
        return selection_analysis_result(payload.selected_text)

    monkeypatch.setattr(corpus_service, "analyze_corpus_selection", analyze)
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="corpus_detail_owner")
    try:
        created = client.post(
            "/api/corpus",
            json={"kind": "idiom", "text": "that escapes me", "tags": ["idiom"]},
        )
        assert created.status_code == 201
        item_id = created.json()["id"]
        context = {
            "selected_text": "that escapes me",
            "current_sentence": "For some reason that escapes me, it remains there.",
            "context_before": "The artifact came from Babylon.",
            "context_after": "Its location surprises the author.",
            "timestamp": "0:12",
        }

        first = client.post(f"/api/corpus/{item_id}/analysis-detail", json=context)
        second = client.post(f"/api/corpus/{item_id}/analysis-detail", json=context)

        assert first.status_code == 200
        assert second.status_code == 200
        assert calls == 1
        assert second.json()["analysis_detail"] == first.json()["analysis_detail"]
        assert second.json()["analysis_detail"]["context"]["context_before"] == context["context_before"]
        assert second.json()["analysis_detail"]["analysis"]["explanation"]["meaning"]
    finally:
        app.dependency_overrides.clear()


def test_private_routes_require_identity_and_enforce_ownership() -> None:
    assert client.get("/api/corpus").status_code == 401

    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="user_owner")
    try:
        created = client.post(
            "/api/corpus",
            json={"kind": "structure", "text": "The point is {point}"},
        )
        assert created.status_code == 201
        item_id = created.json()["id"]
    finally:
        app.dependency_overrides.clear()

    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="user_other")
    try:
        listed = client.get("/api/corpus")
        assert listed.status_code == 200
        assert all(item["id"] != item_id for item in listed.json())

        updated = client.patch(f"/api/corpus/{item_id}", json={"text": "stolen"})
        assert updated.status_code == 404
    finally:
        app.dependency_overrides.clear()
