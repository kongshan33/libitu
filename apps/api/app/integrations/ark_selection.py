import json
from functools import lru_cache
from pathlib import Path
from time import sleep

import httpx
from pydantic import ValidationError

from app.config import get_settings
from app.integrations.ark_analysis import AnalysisProviderError
from app.schemas.corpus import CorpusSelectionAnalysis, CorpusSelectionAnalysisRequest


SYSTEM_PROMPT = (
    Path(__file__).parents[1] / "prompts" / "corpus_selection_system.txt"
).read_text(encoding="utf-8").strip()


def generate_selection_analysis(
    payload: CorpusSelectionAnalysisRequest,
) -> CorpusSelectionAnalysis:
    settings = get_settings()
    if not settings.ark_api_key:
        raise AnalysisProviderError("Doubao is not configured.", code="analysis_not_configured")

    request_payload = {
        "model": settings.ark_model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": _selection_user_prompt(payload),
            },
        ],
        "response_format": {"type": "json_object"},
        "thinking": {"type": "disabled"},
        "temperature": 0.1,
        "max_tokens": min(settings.ark_max_output_tokens, 8_000),
        "stream": False,
    }

    last_error: Exception | None = None
    for attempt in range(max(1, settings.ark_max_attempts)):
        try:
            response = _selection_client().post(
                "/chat/completions",
                headers={"Authorization": f"Bearer {settings.ark_api_key}"},
                json=request_payload,
            )
            response.raise_for_status()
            return _parse_selection_response(response.json())
        except (
            AnalysisProviderError,
            httpx.HTTPError,
            KeyError,
            IndexError,
            TypeError,
            json.JSONDecodeError,
            ValidationError,
        ) as error:
            last_error = error
            if attempt + 1 < max(1, settings.ark_max_attempts) and _is_retryable(error):
                sleep(0.5 * (attempt + 1))
                continue
            break

    raise _selection_provider_error(last_error)


def _selection_user_prompt(payload: CorpusSelectionAnalysisRequest) -> str:
    context = {
        "selected_text": payload.selected_text,
        "current_sentence": payload.current_sentence,
        "context_before": payload.context_before,
        "context_after": payload.context_after,
        "timestamp": payload.timestamp,
    }
    return (
        "用户选中文本与局部上下文如下。请完成解释和句法分析任务：\n"
        + json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    )


def _parse_selection_response(payload: dict) -> CorpusSelectionAnalysis:
    choice = payload["choices"][0]
    finish_reason = choice.get("finish_reason")
    if finish_reason != "stop":
        raise AnalysisProviderError(
            "Doubao did not complete the selection analysis.",
            code="selection_analysis_incomplete",
            retryable=finish_reason in {"length", "insufficient_system_resource"},
        )
    content = choice["message"]["content"]
    result = json.loads(content)
    if not isinstance(result, dict):
        raise TypeError("Selection analysis must be a JSON object.")
    result["analysis_source"] = "ai"
    result["provider_notice"] = None
    return CorpusSelectionAnalysis.model_validate(result)


def _selection_provider_error(error: Exception | None) -> AnalysisProviderError:
    if isinstance(error, AnalysisProviderError):
        return error
    if isinstance(error, httpx.TimeoutException):
        return AnalysisProviderError(
            "Doubao timed out while analyzing the selection.",
            code="selection_analysis_timeout",
            retryable=True,
        )
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        return AnalysisProviderError(
            f"Doubao rejected the selection analysis request (HTTP {status}).",
            code="selection_analysis_rate_limited" if status == 429 else "selection_analysis_rejected",
            retryable=status == 429 or status >= 500,
        )
    if isinstance(error, httpx.TransportError):
        return AnalysisProviderError(
            "Doubao could not be reached for selection analysis.",
            code="selection_analysis_unreachable",
            retryable=True,
        )
    return AnalysisProviderError(
        "Doubao returned an invalid selection analysis.",
        code="selection_analysis_invalid",
        retryable=True,
    )


def _is_retryable(error: Exception) -> bool:
    if isinstance(error, AnalysisProviderError):
        return error.retryable
    if isinstance(error, httpx.HTTPStatusError):
        return error.response.status_code == 429 or error.response.status_code >= 500
    return isinstance(
        error,
        (
            httpx.TimeoutException,
            httpx.TransportError,
            KeyError,
            IndexError,
            TypeError,
            json.JSONDecodeError,
            ValidationError,
        ),
    )


@lru_cache
def _selection_client() -> httpx.Client:
    settings = get_settings()
    return httpx.Client(
        base_url=settings.ark_base_url.rstrip("/"),
        timeout=httpx.Timeout(settings.ark_timeout_seconds, connect=10.0),
        limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
    )
