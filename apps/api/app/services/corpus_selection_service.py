import re

from app.integrations.deepseek import AnalysisProviderError
from app.integrations.deepseek_selection import generate_selection_analysis
from app.schemas.corpus import (
    CorpusReusablePattern,
    CorpusSelectionAnalysis,
    CorpusSelectionAnalysisRequest,
    CorpusSelectionExplanation,
    CorpusSelectionFields,
    CorpusSelectionPronunciation,
    CorpusSelectionSyntaxAnalysis,
    CorpusSelectionTranslation,
)


def analyze_corpus_selection(
    payload: CorpusSelectionAnalysisRequest,
) -> CorpusSelectionAnalysis:
    try:
        analysis = generate_selection_analysis(payload)
    except AnalysisProviderError as error:
        return _unavailable_analysis(payload, str(error))
    return _normalize_evidenced_analysis(payload, analysis)


def _normalize_evidenced_analysis(
    payload: CorpusSelectionAnalysisRequest,
    analysis: CorpusSelectionAnalysis,
) -> CorpusSelectionAnalysis:
    selected = _normalize_space(payload.selected_text)
    sentence = _normalize_space(payload.current_sentence)
    recommended = _evidenced_recommendation(analysis.recommended_text, selected, sentence)
    expanded = _comparison_key(recommended) != _comparison_key(selected)
    completeness = analysis.completeness
    if expanded:
        completeness = "needs_expansion"
    elif completeness == "needs_expansion":
        completeness = "complete"

    evidence = [
        value
        for value in (
            _normalize_space(payload.context_before or ""),
            sentence,
            _normalize_space(payload.context_after or ""),
        )
        if value
    ]
    explanation = analysis.explanation.model_copy(
        update={
            "pronunciation": analysis.explanation.pronunciation.model_copy(
                update={"audio_text": selected}
            )
        }
    )
    syntax_analysis = analysis.syntax_analysis.model_copy(update={"evidence": evidence})
    return analysis.model_copy(
        update={
            "analysis_source": "ai",
            "provider_notice": None,
            "selected_text": selected,
            "recommended_text": recommended,
            "completeness": completeness,
            "explanation": explanation,
            "syntax_analysis": syntax_analysis,
        }
    )


def _evidenced_recommendation(value: str, selected: str, sentence: str) -> str:
    candidate = _normalize_space(value)
    if _comparison_key(candidate) == _comparison_key(selected):
        return selected

    start = sentence.casefold().find(candidate.casefold())
    if start >= 0:
        return sentence[start : start + len(candidate)]
    return selected


def _comparison_key(value: str) -> str:
    return " ".join(re.findall(r"[a-z0-9']+", value.casefold()))


def _normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _unavailable_analysis(
    payload: CorpusSelectionAnalysisRequest,
    provider_message: str,
) -> CorpusSelectionAnalysis:
    selected = _normalize_space(payload.selected_text)
    current = _normalize_space(payload.current_sentence)
    context = [
        value
        for value in (
            _normalize_space(payload.context_before or ""),
            current,
            _normalize_space(payload.context_after or ""),
        )
        if value
    ]
    notice = "AI 分析暂时不可用；当前仅保留你的原始选择，不会猜测含义或擅自补全边界。"
    return CorpusSelectionAnalysis(
        analysis_source="fallback",
        provider_notice=f"{notice} {provider_message}",
        selection_type="sentence" if selected.endswith((".", "?", "!")) else "phrase",
        completeness="complete",
        selected_text=selected,
        recommended_text=selected,
        recommendation_reason="AI 未完成边界判断，因此默认按你实际选中的内容保存。",
        fields=CorpusSelectionFields(
            kind="chunk",
            tags=["discourse"],
            level="B1",
            register="neutral",
        ),
        note_placeholder="可选：写下你的理解、联想或使用场景",
        explanation=CorpusSelectionExplanation(
            pronunciation=CorpusSelectionPronunciation(
                ipa="待 AI 分析",
                connected_speech="AI 可用后会结合上下文分析重音、弱读和连读。",
                audio_text=selected,
            ),
            meaning="AI 暂时不可用，无法可靠解释这段选择在当前上下文中的具体含义。",
            pragmatic_function="AI 暂时不可用，无法可靠判断它在这段对话中的语用作用。",
            similar_expressions=[],
            examples=[],
            usage_chips=["等待 AI 分析"],
        ),
        syntax_analysis=CorpusSelectionSyntaxAnalysis(
            sentence_type="待 AI 判断",
            main_clause="待 AI 分析",
            structure_breakdown=[],
            logic_relations=[],
            information_hierarchy=[],
            style_features=[],
            usage_scenarios=[],
            grammar_points=[],
            wording_notes=[],
            reusable_patterns=[
                CorpusReusablePattern(
                    template=selected,
                    slots={},
                    rationale="AI 暂时不可用，因此不自动抽象结构。",
                )
            ],
            translations=[
                CorpusSelectionTranslation(
                    label="待分析",
                    text="AI 暂时不可用，未生成翻译。",
                    recommended=True,
                )
            ],
            translation_notes=[],
            evidence=context,
        ),
    )
