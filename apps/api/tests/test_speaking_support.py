from copy import deepcopy
import json
from types import SimpleNamespace

import pytest

from app.services import speaking_teaching as teaching
from app.services.speaking_support import effective_support, find_variant_quote, support_matches, variant_supported
from test_speaking_teaching import analyze, candidate, mission, model, recommendation, utterance


@pytest.fixture(autouse=True)
def no_paid_analysis(monkeypatch):
    monkeypatch.setattr(teaching, "get_settings", lambda: SimpleNamespace(
        ark_api_key=None, ark_base_url="https://analyzer.invalid", ark_model="fixture-model"))


def supported_mission(level="model_frame"):
    return mission(("chunk", "to be fair")).model_copy(update={"support_level": level})


def three_turns():
    return [utterance("The revised deadline needs discussion.", ordinal=index) for index in range(1, 4)]


def test_support_is_pure_explicit_and_versioned_with_legacy_compatibility():
    session = supported_mission()
    document = {"support": {"level": "no_hint", "version": 2, "history": [{"private": True}]}}
    original = deepcopy(document)
    assert effective_support(session, {}) == {"level": "model_frame", "version": 0}
    assert effective_support(session, document) == {"level": "no_hint", "version": 2}
    assert document == original
    assert support_matches({"support_level": "no_hint", "support_version": 2}, session, document)
    assert not support_matches({"support_level": "model_frame", "support_version": 0}, session, document)
    assert not support_matches({}, session, {})
    assert not support_matches({"support_level": "model_frame", "support_version": False}, session, {})
    assert effective_support(mission(), {}) is None
    assert support_matches({}, mission(), {})
    assert not support_matches({"support_level": "no_hint", "support_version": 0}, mission(), {})


@pytest.mark.parametrize("level,action", [
    ("model_frame", "model_then_transfer"), ("model_label", "model_then_transfer"),
    ("label_only", "implicit_elicitation"), ("no_hint", "implicit_elicitation"), (None, "implicit_elicitation"),
])
def test_support_selects_modeling_only_after_observation_and_never_counts_exposure(monkeypatch, level, action):
    session = supported_mission(level)
    model(monkeypatch, recommendation=recommendation(session.items[0]))
    history = three_turns()
    assert analyze(session, history[1], history[:2])["policy"]["action"] == "continue_naturally"
    result = analyze(session, history[2], history)
    policy = result["policy"]
    assert policy["action"] == action
    assert policy.get("support_level") == level
    assert policy.get("support_version") == (0 if level else None)
    assert result["controller"]["exposures"] == []
    assert result["controller"]["automatic_attempts"] == {}
    assert all(row["observed_uses"] == 0 for row in result["learning"])
    if action == "model_then_transfer":
        assert "exactly once" in policy["instruction"]
        assert "DIFFERENT content" in policy["instruction"]
        assert "request imitation" in policy["instruction"]
    else:
        assert session.items[0].text not in policy["instruction"].lower()


@pytest.mark.parametrize("change", ["closing", "unrelated", "skipped"])
def test_modeling_respects_context_and_skipped_targets(monkeypatch, change):
    session = supported_mission()
    target = str(session.items[0].id)
    suggestion = recommendation(session.items[0], closing=change == "closing",
                                context_sufficient=change != "unrelated")
    model(monkeypatch, recommendation=suggestion)
    history = three_turns()
    previous = {"target_states": {target: {"skipped": True, "version": 1}}} if change == "skipped" else {}
    result = analyze(session, history[2], history, previous)
    assert result["policy"]["action"] not in {"model_then_transfer", "implicit_elicitation"}


def test_setting_override_is_fenced_when_analysis_finishes_after_a_switch(monkeypatch):
    session = supported_mission()
    model(monkeypatch, recommendation=recommendation(session.items[0]))
    history = three_turns()
    previous = {"messages": history, "support": {"level": "model_frame", "version": 0}}
    result = analyze(session, history[-1], history, previous)
    assert result["policy"]["action"] == "model_then_transfer"
    current = {**deepcopy(previous), "support": {"level": "no_hint", "version": 1}}
    merged = teaching.reconcile_analysis_result(session, current, result, previous)
    assert merged["policy"]["status"] == "expired"
    assert merged["policy"]["expiry_reason"] == "support_changed"
    assert result["policy"]["status"] == "pending"
    assert "support" not in merged  # The CAS caller retains its current setting/history.
    later = utterance("The deadline still needs discussion.", ordinal=4)
    next_result = analyze(session, later, [*history, later], {**current, **merged})
    assert next_result["policy"]["action"] == "implicit_elicitation"
    assert next_result["policy"]["support_version"] == 1


def test_setting_switch_does_not_rewrite_already_sent_policy_or_attempt(monkeypatch):
    session = supported_mission()
    model(monkeypatch, recommendation=recommendation(session.items[0]))
    history = three_turns()
    previous = {"messages": history}
    result = analyze(session, history[-1], history, previous)
    sent = {**deepcopy(result["policy"]), "status": "sent", "response_id": "already-sent"}
    current = {**previous, "policy": sent, "support": {"level": "no_hint", "version": 1},
               "teaching_attempts": [{"id": "attempt", "policy": deepcopy(sent)}]}
    original = deepcopy(current)
    merged = teaching.reconcile_analysis_result(session, current, result, previous)
    assert merged["policy"] == sent
    assert current == original


def test_duplicate_analysis_expires_old_pending_policy_after_setting_switch(monkeypatch):
    session = supported_mission()
    model(monkeypatch, recommendation=recommendation(session.items[0]))
    history = three_turns()
    previous = analyze(session, history[-1], history)
    previous["support"] = {"level": "no_hint", "version": 1}
    result = analyze(session, history[-1], history, previous)
    assert result["analysis_trace"]["skip_reason"] == "duplicate_revision"
    assert result["policy"]["status"] == "expired"
    assert result["policy"]["expiry_reason"] == "support_changed"


@pytest.mark.parametrize("confirmed", [False, True])
def test_partial_audio_stays_unknown_across_session_and_full_example_takes_precedence(confirmed):
    session = supported_mission("no_hint")
    history = [utterance("We need more time.", ordinal=index) for index in range(1, 7)]
    message = utterance("To be fair, this deadline could work.", ordinal=7,
                        started_at="2026-10-20T10:01:00+00:00", finalized_at="2026-10-20T10:01:05+00:00")
    exposure = {"id": "partial", "target_item_id": str(session.items[0].id),
                "source_message_id": history[0]["id"], "source_revision": 1,
                "after_turn": 1, "kind": "assistant_audio", "level": "example", "scope": "session",
                "certainty": "possible", "visible_at": "2026-10-20T10:00:05+00:00"}
    state = {"controller": {"exposures": [exposure]}}
    if confirmed:
        state["controller"]["exposures"].append({
            **exposure, "id": "full-example", "certainty": "confirmed", "after_turn": 3,
            "visible_at": "2026-10-20T10:00:15+00:00"})
    result = analyze(session, message, [*history, message], state)
    assert result["evidence"][0]["assistance"] == ("example" if confirmed else "unknown")
    assert result["evidence"][0]["prompted"] is confirmed
    assert result["learning"][0]["independent_uses"] == 0


def test_late_partial_audio_receipt_cannot_reclassify_an_already_finished_utterance():
    session = supported_mission()
    message = utterance("To be fair, we can wait.", ordinal=2,
                        started_at="2026-10-20T10:00:00+00:00", finalized_at="2026-10-20T10:00:05+00:00")
    state = {"hint_exposure": {"id": "late", "target_item_id": str(session.items[0].id),
        "source_message_id": None, "source_revision": None, "after_turn": 0, "kind": "assistant_audio",
        "certainty": "possible", "scope": "session", "level": "example",
        "visible_at": "2026-10-20T10:00:08+00:00"}}
    result = analyze(session, message, [message], state)
    assert result["evidence"][0]["assistance"] == "independent"
    assert result["controller"]["exposures"][0]["certainty"] == "possible"


@pytest.mark.parametrize("target,quote,accepted", [
    ("I'm convinced", "I am convinced", True),
    ("take breaks", "take break", True),
    ("I'm convinced", "I believe", False),
    ("to be fair", "We should consider both sides", False),
    ("", "", False),
])
def test_variants_keep_the_conservative_stage_five_rule(monkeypatch, target, quote, accepted):
    assert variant_supported(target, quote) is accepted
    if not target:
        return
    session = mission(("chunk", target))
    model(monkeypatch, [candidate(session.items[0], quote, kind="variant")])
    result = analyze(session, utterance(quote))
    assert bool(result["evidence"]) is accepted
    if not accepted:
        assert result["analysis_trace"]["rejected"][0]["reason"] == "variant_target_not_grounded"


@pytest.mark.parametrize("target,text,quote", [
    ("I'm convinced", "🙂 I am convinced the pilot is useful.", "I am convinced"),
    ("I am convinced", "Well, I’m convinced we should try.", "I’m convinced"),
    ("take breaks", "Please take break before we continue.", "take break"),
    ("I'm convinced", "I believe the pilot is useful.", None),
    ("I'm convinced", "I am almost convinced we should try.", None),
    ("I'm convinced", "I am. Convinced is a strong word.", None),
    ("am convinced", "I'm convinced we should try.", None),
    ("I", "I'm convinced we should try.", None),
    ("", "I am convinced.", None),
])
def test_exposure_variants_return_only_contiguous_original_quotes(target, text, quote):
    assert find_variant_quote(text, target) == quote
    if quote is not None:
        assert quote in text and variant_supported(target, quote)


def test_pattern_family_is_context_only_and_does_not_expand_variant_matching(monkeypatch):
    session = supported_mission()
    session.items[0].pattern_family = "concession"
    captured = []
    async def provider(settings, prompt, context, **kwargs):
        captured.append(context)
        return json.dumps({"evidence": [], "needs_help": None}), {}
    monkeypatch.setattr(teaching, "request_analysis_json", provider)
    analyze(session, utterance("We need another day."))
    assert captured[0]["selected_language"][0]["pattern_family"] == "concession"
