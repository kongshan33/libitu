import json
import re
from collections.abc import Callable
from functools import lru_cache
from pathlib import Path
from time import monotonic, sleep

import httpx
from pydantic import ValidationError
from pydantic_core import from_json

from app.config import get_settings
from app.schemas.analysis import (
    AnalysisCorpusItem,
    AnalysisLogicNode,
    BlueprintAnalysis,
    BlueprintAnalysisPreview,
)
from app.schemas.content import ContentResolveResponse


class AnalysisProviderError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "analysis_provider_failed",
        diagnostic: str | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.diagnostic = diagnostic
        self.retryable = retryable


AnalysisProgressCallback = Callable[[BlueprintAnalysisPreview], None]


SYSTEM_PROMPT = (Path(__file__).parents[1] / "prompts" / "stage_one_system.txt").read_text(
    encoding="utf-8"
).strip()


def analyze_transcript(
    content: ContentResolveResponse,
    transcript_text: str,
    on_progress: AnalysisProgressCallback | None = None,
) -> BlueprintAnalysis:
    settings = get_settings()
    if not settings.ark_api_key:
        raise AnalysisProviderError("Doubao is not configured.")

    if len(transcript_text) > settings.ark_max_input_chars:
        raise AnalysisProviderError(
            "This transcript is too long for one analysis job. Split processing is required.",
            code="analysis_input_too_large",
            diagnostic=(
                f"input_chars={len(transcript_text)};"
                f"max_input_chars={settings.ark_max_input_chars}"
            ),
        )
    bounded_transcript = transcript_text
    user_prompt = (
        f"Analyze this transcript as JSON.\nTitle: {content.title or 'Untitled'}\n"
        f"Language: {content.language or 'unknown'}\nTranscript:\n{bounded_transcript}"
    )
    payload = {
        "model": settings.ark_model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "response_format": {"type": "json_object"},
        "thinking": {"type": "disabled"},
        "temperature": 0.2,
        "max_tokens": settings.ark_max_output_tokens,
        "stream": True,
        "stream_options": {"include_usage": True},
    }

    last_error: Exception | None = None
    best_preview: BlueprintAnalysisPreview | None = None

    def emit_monotonic_preview(preview: BlueprintAnalysisPreview) -> None:
        nonlocal best_preview
        merged = _merge_analysis_preview(best_preview, preview)
        if merged == best_preview:
            return
        best_preview = merged
        if on_progress is not None:
            on_progress(merged)

    max_attempts = max(1, settings.ark_max_attempts)
    base_output_tokens = min(settings.ark_max_output_tokens, 32_000)
    for attempt in range(max_attempts):
        attempt_payload = {
            **payload,
            "max_tokens": min(
                base_output_tokens * (attempt + 1),
                64_000,
            ),
        }
        try:
            return _stream_analysis_response(
                attempt_payload,
                transcript_text,
                attempt=attempt + 1,
                max_attempts=max_attempts,
                on_progress=emit_monotonic_preview if on_progress is not None else None,
            )
        except (
            AnalysisProviderError,
            httpx.HTTPError,
            KeyError,
            IndexError,
            TypeError,
            ValueError,
            json.JSONDecodeError,
            ValidationError,
        ) as error:
            last_error = _provider_error(error)
            if attempt + 1 < max_attempts and _is_retryable(last_error):
                sleep(1.5 * (attempt + 1))
                continue
            break

    if isinstance(last_error, AnalysisProviderError):
        raise last_error
    raise AnalysisProviderError("Doubao could not generate the blueprint. Please retry.") from last_error


def _merge_analysis_preview(
    previous: BlueprintAnalysisPreview | None,
    current: BlueprintAnalysisPreview,
) -> BlueprintAnalysisPreview:
    if previous is None:
        return current
    return current.model_copy(
        update={
            "output_chars": max(previous.output_chars, current.output_chars),
            "summary": previous.summary or current.summary,
            "chapters": current.chapters if len(current.chapters) > len(previous.chapters) else previous.chapters,
            "logic_flow": current.logic_flow if len(current.logic_flow) > len(previous.logic_flow) else previous.logic_flow,
            "corpus_items": current.corpus_items if len(current.corpus_items) > len(previous.corpus_items) else previous.corpus_items,
        }
    )


def _stream_analysis_response(
    request_payload: dict,
    transcript_text: str,
    *,
    attempt: int,
    max_attempts: int,
    on_progress: AnalysisProgressCallback | None,
) -> BlueprintAnalysis:
    settings = get_settings()
    content_parts: list[str] = []
    finish_reason: str | None = None
    usage: dict | None = None
    last_preview_at = 0.0
    last_preview_signature: tuple[object, ...] | None = None

    with _ark_analysis_client().stream(
        "POST",
        "/chat/completions",
        headers={"Authorization": f"Bearer {settings.ark_api_key}"},
        json=request_payload,
    ) as response:
        response.raise_for_status()
        for line in response.iter_lines():
            if not line.startswith("data:"):
                continue
            data = line.removeprefix("data:").strip()
            if not data or data == "[DONE]":
                continue
            chunk = json.loads(data)
            choices = chunk.get("choices")
            if isinstance(choices, list) and choices:
                choice = choices[0]
                delta = choice.get("delta") if isinstance(choice, dict) else None
                content = delta.get("content") if isinstance(delta, dict) else None
                if isinstance(content, str) and content:
                    content_parts.append(content)
                if isinstance(choice, dict) and choice.get("finish_reason") is not None:
                    finish_reason = str(choice["finish_reason"])
            if isinstance(chunk.get("usage"), dict):
                usage = chunk["usage"]

            now = monotonic()
            if on_progress is not None and now - last_preview_at >= 0.4:
                preview = _build_analysis_preview("".join(content_parts), transcript_text)
                signature = _preview_signature(preview)
                if signature != last_preview_signature:
                    _emit_analysis_progress(on_progress, preview)
                    last_preview_signature = signature
                last_preview_at = now

    completion_text = "".join(content_parts)
    if finish_reason is None:
        raise AnalysisProviderError(
            "Doubao's response stream ended before completion. Please retry.",
            code="analysis_stream_interrupted",
            diagnostic=f"attempt={attempt}/{max_attempts};output_chars={len(completion_text)}",
            retryable=True,
        )

    if on_progress is not None:
        preview = _build_analysis_preview(completion_text, transcript_text)
        if _preview_signature(preview) != last_preview_signature:
            _emit_analysis_progress(on_progress, preview)

    completion_payload = {
        "choices": [
            {
                "finish_reason": finish_reason,
                "message": {"content": completion_text},
            }
        ],
        "usage": usage or {},
    }
    return _parse_analysis_payload(
        completion_payload,
        transcript_text,
        requested_max_tokens=request_payload.get("max_tokens"),
    )


def _parse_analysis_response(
    response: httpx.Response,
    transcript_text: str,
    requested_max_tokens: int | None = None,
) -> BlueprintAnalysis:
    return _parse_analysis_payload(response.json(), transcript_text, requested_max_tokens)


def _parse_analysis_payload(
    payload: dict,
    transcript_text: str,
    requested_max_tokens: int | None = None,
) -> BlueprintAnalysis:
    choice = payload["choices"][0]
    finish_reason = choice.get("finish_reason")
    if finish_reason == "length":
        raise AnalysisProviderError(
            "Doubao stopped before the blueprint JSON was complete. Please retry.",
            code="analysis_response_truncated",
            diagnostic=_completion_diagnostic(payload, finish_reason, requested_max_tokens),
            retryable=True,
        )
    if finish_reason not in (None, "stop"):
        raise AnalysisProviderError(
            "Doubao could not complete the blueprint. Please retry.",
            code="analysis_response_incomplete",
            diagnostic=_completion_diagnostic(payload, finish_reason, requested_max_tokens),
            retryable=finish_reason == "insufficient_system_resource",
        )

    message = choice["message"]["content"]
    if not message:
        raise AnalysisProviderError(
            "Doubao returned an empty blueprint. Please retry.",
            code="analysis_response_empty",
            diagnostic="empty_content",
            retryable=True,
        )
    try:
        payload = json.loads(message)
    except json.JSONDecodeError as error:
        raise AnalysisProviderError(
            "Doubao returned malformed blueprint JSON. Please retry.",
            code="analysis_response_invalid_json",
            diagnostic=f"json_decode_error@{error.pos}",
            retryable=True,
        ) from error

    normalized = _normalize_analysis_payload(payload, transcript_text)
    try:
        return BlueprintAnalysis.model_validate(normalized)
    except ValidationError as error:
        issue = error.errors(include_url=False)[0]
        location = ".".join(str(part) for part in issue["loc"]) or "root"
        raise AnalysisProviderError(
            f"Doubao returned an invalid blueprint field ({location}). Please retry.",
            code="analysis_response_schema_invalid",
            diagnostic=f"{issue['type']}@{location}",
            retryable=True,
        ) from error


def _normalize_analysis_payload(payload: object, transcript_text: str) -> object:
    if not isinstance(payload, dict):
        return payload

    normalized = dict(payload)
    list_limits = {
        "chapters": 12,
        "logic_flow": 6,
        "corpus_items": 32,
        "key_points": 8,
        "scenario_suggestions": 6,
    }
    for field, limit in list_limits.items():
        value = normalized.get(field)
        if isinstance(value, list):
            normalized[field] = value[:limit]

    if isinstance(normalized.get("summary"), str):
        normalized["summary"] = normalized["summary"].strip()[:1200]

    logic_flow = normalized.get("logic_flow")
    if isinstance(logic_flow, list):
        normalized["logic_flow"] = [
            {
                **node,
                "title": _trim_string(node.get("title"), 80),
                "subtitle": _trim_string(node.get("subtitle"), 180),
            }
            if isinstance(node, dict)
            else node
            for node in logic_flow
        ]

    transcript = _normalized_text(transcript_text)
    corpus_items = normalized.get("corpus_items")
    if isinstance(corpus_items, list):
        normalized_items = [
            _normalize_corpus_item(item, transcript) if isinstance(item, dict) else item
            for item in corpus_items
        ]
        normalized["corpus_items"] = _retain_valid_corpus_items(normalized_items)
    return normalized


def _build_analysis_preview(content: str, transcript_text: str) -> BlueprintAnalysisPreview:
    try:
        payload = from_json(content.encode(), allow_partial=True)
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    summary_value = payload.get("summary")
    summary = _trim_string(summary_value, 1200) if isinstance(summary_value, str) else None
    chapters_value = payload.get("chapters")
    chapters = (
        [_trim_string(item, 120) for item in chapters_value if isinstance(item, str) and item.strip()][:12]
        if isinstance(chapters_value, list)
        else []
    )

    logic_flow: list[AnalysisLogicNode] = []
    logic_value = payload.get("logic_flow")
    if isinstance(logic_value, list):
        for node in logic_value[:6]:
            if not isinstance(node, dict):
                continue
            normalized_node = {
                **node,
                "title": _trim_string(node.get("title"), 80),
                "subtitle": _trim_string(node.get("subtitle"), 180),
            }
            try:
                logic_flow.append(AnalysisLogicNode.model_validate(normalized_node))
            except ValidationError:
                continue

    transcript = _normalized_text(transcript_text)
    corpus_items: list[AnalysisCorpusItem] = []
    corpus_value = payload.get("corpus_items")
    if isinstance(corpus_value, list):
        seen: set[tuple[str, str]] = set()
        for item in corpus_value[:32]:
            if not isinstance(item, dict):
                continue
            try:
                candidate = AnalysisCorpusItem.model_validate(
                    _normalize_corpus_item(item, transcript)
                )
            except ValidationError:
                continue
            source_text = _normalized_text(candidate.source_text)
            dedupe_key = (candidate.kind, _normalized_text(candidate.text))
            if (
                not source_text
                or source_text not in transcript
                or dedupe_key in seen
                or not _is_useful_preview_item(candidate)
            ):
                continue
            seen.add(dedupe_key)
            corpus_items.append(candidate)

    return BlueprintAnalysisPreview(
        output_chars=len(content),
        summary=summary,
        chapters=chapters,
        logic_flow=logic_flow,
        corpus_items=corpus_items,
    )


def _is_useful_preview_item(item: AnalysisCorpusItem) -> bool:
    if item.kind == "structure":
        return re.search(r"\[[a-z][a-z0-9 _-]*\]", item.text, re.I) is not None

    words = re.findall(r"[a-z0-9']+", item.text.casefold())
    filler_only = {"uh", "um", "well", "like", "you", "know", "i", "think"}
    quality = item.naturalness_score + item.transferability_score + item.learning_value_score
    return 2 <= len(words) <= 14 and not set(words).issubset(filler_only) and quality >= 10


def _preview_signature(preview: BlueprintAnalysisPreview) -> tuple[object, ...]:
    return (
        preview.summary,
        len(preview.chapters),
        len(preview.logic_flow),
        len(preview.corpus_items),
        preview.output_chars // 2000,
    )


def _emit_analysis_progress(
    callback: AnalysisProgressCallback,
    preview: BlueprintAnalysisPreview,
) -> None:
    try:
        callback(preview)
    except Exception as error:
        print(
            json.dumps(
                {
                    "event": "analysis_progress_callback_failed",
                    "exception_type": type(error).__name__,
                },
                separators=(",", ":"),
            ),
            flush=True,
        )


def _completion_diagnostic(
    payload: object,
    finish_reason: object,
    requested_max_tokens: int | None,
) -> str:
    details = [f"finish_reason={finish_reason}"]
    usage = payload.get("usage") if isinstance(payload, dict) else None
    if isinstance(usage, dict) and isinstance(usage.get("completion_tokens"), int):
        details.append(f"completion_tokens={usage['completion_tokens']}")
    if requested_max_tokens is not None:
        details.append(f"max_tokens={requested_max_tokens}")
    return ";".join(details)


def _retain_valid_corpus_items(items: list[object]) -> list[object]:
    if not items:
        return items

    valid_items: list[dict] = []
    invalid_fields: list[str] = []
    for index, item in enumerate(items):
        try:
            validated = AnalysisCorpusItem.model_validate(item)
        except ValidationError as error:
            issue = error.errors(include_url=False)[0]
            location = ".".join(str(part) for part in issue["loc"])
            invalid_fields.append(f"{index}.{location or 'root'}")
            continue
        valid_items.append(validated.model_dump(mode="json"))

    if not valid_items:
        return items
    if invalid_fields:
        print(
            json.dumps(
                {
                    "event": "ark_analysis_corpus_items_dropped",
                    "dropped_count": len(invalid_fields),
                    "retained_count": len(valid_items),
                    "invalid_fields": invalid_fields[:8],
                },
                separators=(",", ":"),
            ),
            flush=True,
        )
    return valid_items


def _normalize_corpus_item(item: dict, transcript: str) -> dict:
    normalized = dict(item)
    kind = normalized.get("kind")
    if isinstance(kind, str):
        normalized["kind"] = kind.strip().lower()
    level = normalized.get("level")
    if isinstance(level, str):
        normalized["level"] = level.strip().upper()
    tags = normalized.get("tags")
    if isinstance(tags, list):
        normalized["tags"] = [tag.strip().lower() for tag in tags if isinstance(tag, str)][:3]

    for field in ("text", "source_text", "meaning"):
        normalized[field] = _trim_string(normalized.get(field), 240)
    normalized["usage_note"] = _trim_string(normalized.get("usage_note"), 320)
    normalized["phonology_note"] = _trim_string(normalized.get("phonology_note"), 320)

    register = normalized.get("register")
    if isinstance(register, str):
        normalized["register"] = register.strip().lower()
    pattern_family = normalized.get("pattern_family")
    if isinstance(pattern_family, str):
        normalized["pattern_family"] = pattern_family.strip().lower()
    scenario_tags = normalized.get("scenario_tags")
    if isinstance(scenario_tags, list):
        normalized["scenario_tags"] = [
            tag.strip().lower() for tag in scenario_tags if isinstance(tag, str)
        ][:3]

    text = normalized.get("text")
    source_text = normalized.get("source_text")
    if normalized.get("kind") == "structure" and isinstance(text, str):
        normalized["text"] = re.sub(r"[<{]([^>{}]+)[>}]", r"[\1]", text)
        text = normalized["text"]
    if normalized.get("kind") == "chunk" and isinstance(text, str) and isinstance(source_text, str):
        if text != source_text:
            if _normalized_text(source_text) in transcript:
                normalized["text"] = source_text
            elif _normalized_text(text) in transcript:
                normalized["source_text"] = text
    return normalized


def _trim_string(value: object, limit: int) -> object:
    return value.strip()[:limit] if isinstance(value, str) else value


def _normalized_text(value: str) -> str:
    return " ".join(re.findall(r"[a-z0-9']+", value.casefold()))


def _provider_error(error: Exception) -> AnalysisProviderError:
    if isinstance(error, AnalysisProviderError):
        return error
    if isinstance(error, httpx.TimeoutException):
        return AnalysisProviderError(
            "Doubao timed out while generating the blueprint. Please retry.",
            code="analysis_provider_timeout",
            diagnostic=type(error).__name__,
            retryable=True,
        )
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        return AnalysisProviderError(
            f"Doubao rejected the blueprint request (HTTP {status}).",
            code="analysis_provider_rate_limited" if status == 429 else "analysis_provider_rejected",
            diagnostic=f"http_status={status}",
            retryable=status == 429 or status >= 500,
        )
    if isinstance(error, httpx.TransportError):
        return AnalysisProviderError(
            "Doubao could not be reached. Please retry.",
            code="analysis_provider_unreachable",
            diagnostic=type(error).__name__,
            retryable=True,
        )
    return AnalysisProviderError(
        "Doubao returned an unreadable blueprint response. Please retry.",
        code="analysis_response_unreadable",
        diagnostic=type(error).__name__,
        retryable=True,
    )


@lru_cache
def _ark_analysis_client() -> httpx.Client:
    settings = get_settings()
    return httpx.Client(
        base_url=settings.ark_base_url.rstrip("/"),
        timeout=httpx.Timeout(settings.ark_timeout_seconds, connect=10.0),
        limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
    )


def _is_retryable(error: Exception) -> bool:
    if isinstance(error, AnalysisProviderError):
        return error.retryable
    if isinstance(error, httpx.HTTPStatusError):
        return error.response.status_code == 429 or error.response.status_code >= 500
    return isinstance(
        error,
        (
            httpx.TransportError,
            KeyError,
            IndexError,
            TypeError,
            ValueError,
            json.JSONDecodeError,
            ValidationError,
        ),
    )
