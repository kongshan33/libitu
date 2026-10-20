"""Selected wording stays with analysis; the voice partner elicits its meaning."""
import json

import pytest

from app.integrations.speaking_gemini import gemini_configuration
from app.integrations.speaking_realtime import role_instructions
from app.services import speaking_teaching as teaching
from test_speaking_teaching import analyze, mission, model, recommendation, utterance
from test_speaking_gemini import settings


def test_gemini_setup_withholds_selected_wording_but_preserves_mission():
    session = mission(("chunk", "One trade-off is"))
    setup = gemini_configuration(settings(), session)["setup"]
    prompt = setup["systemInstruction"]["parts"][0]["text"]
    assert session.goal in prompt
    assert "One trade-off is" not in prompt
    assert "language_targets" not in prompt
    # The alternate provider's existing contract is not silently changed.
    assert "One trade-off is" in role_instructions(session)


def test_implicit_control_sends_learner_task_without_target_or_example(monkeypatch):
    session = mission(("chunk", "One trade-off is"))
    model(monkeypatch, recommendation=recommendation(
        session.items[0], intent="Weigh lower costs against less maintenance",
        opportunity="How would you weigh the cheaper option against easier upkeep?",
    ))
    history = [utterance(text, ordinal=i) for i, text in enumerate([
        "We are choosing a database.", "Our team is small.",
        "I want to compare the lower bill with the time spent on maintenance.",
    ])]
    result = analyze(session, history[-1], history)
    policy = result["policy"]
    assert policy["action"] == "implicit_elicitation"
    assert policy["target_text"] == session.items[0].text
    assert policy["target_kind"] == "chunk"
    assert policy["prompt_version"] == teaching.POLICY_PROMPT_VERSION
    assert session.items[0].text not in policy["instruction"]
    payload = json.loads(policy["instruction"].split("\n", 1)[1])
    assert set(payload) == {"learner_intent", "elicitation_question", "skip_when"}
    assert payload["elicitation_question"] == policy["opportunity"]


@pytest.mark.parametrize("field", ["intent", "opportunity", "skip_when"])
def test_recommendation_cannot_smuggle_selected_wording_into_voice_control(monkeypatch, field):
    session = mission(("chunk", "One trade-off is"))
    model(monkeypatch, recommendation=recommendation(
        session.items[0], **{field: "Ask the learner to say: one trade off is lower costs."},
    ))
    history = [utterance("We want to compare both options.", ordinal=i) for i in range(3)]
    result = analyze(session, history[-1], history)
    assert result["policy"]["action"] == "continue_naturally"
    assert any(row["reason"] == "elicitation_contains_target" for row in result["analysis_trace"]["rejected"])


@pytest.mark.parametrize("field", ["intent", "opportunity", "skip_when"])
@pytest.mark.parametrize("wording", [
    "Ask the learner to say: The more you change scope, the more you need to adjust the schedule.",
    "The more you change scope, the more you need to adjust the schedule, as a complete example.",
    "An example: The more you change scope, the more you need to adjust the schedule. Can you repeat that?",
    "Use the pattern The more you [action], the more you [result].",
])
def test_wrapped_structure_cannot_enter_implicit_control(monkeypatch, field, wording):
    session = mission(("structure", "The more you [action], the more you [result]"))
    model(monkeypatch, recommendation=recommendation(session.items[0], **{field: wording}))
    history = [utterance("We need to compare the schedule changes.", ordinal=i) for i in range(3)]
    result = analyze(session, history[-1], history)
    assert result["policy"]["action"] == "continue_naturally"
    assert any(row["reason"] == "elicitation_contains_target" for row in result["analysis_trace"]["rejected"])


@pytest.mark.parametrize("wording", [
    "The more you change scope. The more you need to adjust the schedule.",
    "The more you change scope\nThe more you need to adjust the schedule.",
    "The more you change scope, the more you.",
])
def test_structure_exposure_does_not_join_sentences_or_accept_empty_slots(wording):
    assert teaching.find_target_quote(wording, "The more you [action], the more you [result]", "structure") is None


@pytest.mark.parametrize("target,wording,quote", [
    ("One trade-off is", "Could you say ONE trade–off is worth considering?", "ONE trade–off is"),
    ("I'm convinced", "They said I’m convinced this works.", "I’m convinced"),
])
def test_target_exposure_retains_existing_case_and_typography_matching(target, wording, quote):
    assert teaching.find_target_quote(wording, target, "chunk") == (quote, "exact")


def test_structure_surrounding_match_preserves_original_pattern_length_bound():
    pattern = "The more you [action], the more you [result]".ljust(1000)
    text = "For instance, the more you change scope, the more you need to adjust the schedule today"
    assert teaching.find_target_quote(text, pattern, "structure") == (text, "structure")
    # Optional surrounding context is only for exposure, never evidence validation.
    assert not teaching._structure_supported(pattern, text)
    assert teaching.find_target_quote(text, pattern + " ", "structure") is None
