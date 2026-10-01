import importlib.util
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.integrations import sentence_syntax
from app.integrations.sentence_syntax import MAX_PARSE_TOKENS, SentenceSyntax, get_sentence_syntax


class ParsedDoc(list):
    def has_annotation(self, name):
        return name == "DEP"


class StubPipeline:
    """Fixed dependency evidence without importing a model or spaCy itself."""

    def __init__(self, annotations=()):
        self.annotations = annotations
        self.inputs = []
        self.parse_calls = 0

    def make_doc(self, text):
        self.inputs.append(text)
        return ParsedDoc([
            SimpleNamespace(
                i=index, text=match.group(), lower_=match.group().casefold(), idx=match.start(),
                is_punct=not match.group().isalnum(), is_space=False,
                dep_="", pos_="", children=[],
            )
            for index, match in enumerate(re.finditer(r"\w+|[^\w\s]", text))
        ])

    def __call__(self, doc):
        self.parse_calls += 1
        for token, (pos, dep, head) in zip(doc, self.annotations, strict=True):
            token.pos_ = pos
            token.dep_ = dep
            token.head = doc[head]
        for token in doc:
            token.children = [child for child in doc if child.head is token and child is not token]
        return doc


def test_dependency_evidence_joins_a_dangling_determiner_without_changing_input():
    pipeline = StubPipeline([
        ("PRON", "nsubj", 1), ("VERB", "ROOT", 1), ("DET", "det", 4),
        ("ADJ", "amod", 4), ("NOUN", "dobj", 1), ("PUNCT", "punct", 1),
    ])
    syntax = SentenceSyntax(pipeline)
    left, right = "We need the.", "new plan."
    assert syntax.should_merge(left, right, "punctuation_model")
    assert pipeline.inputs == ["We need the new plan."]
    assert (left, right) == ("We need the.", "new plan.")


@pytest.mark.parametrize(("left", "right", "source"), [
    ("We need the.", "new plan.", "source_punctuation"),
    ("Who did you speak with?", "The manager.", "punctuation_model"),
    ('Who did you speak with?"', "The manager.", "punctuation_model"),
    ("Go!", "And hurry.", "punctuation_model"),
    ("I know.", "Which is yours?", "punctuation_model"),
    ("Yes, we can.", "Start now.", "punctuation_model"),
    ("We need the.", "new plan.", "unknown_boundary"),
    ("Close the door.", "Sit down.", "punctuation_model"),
    ("", "We need the.", "punctuation_model"),
])
def test_source_turn_and_complete_sentence_guards_need_no_inference(left, right, source):
    pipeline = StubPipeline()
    assert not SentenceSyntax(pipeline).should_merge(left, right, source)
    assert pipeline.inputs == []


def test_a_long_candidate_is_bounded_before_model_inference():
    pipeline = StubPipeline()
    syntax = SentenceSyntax(pipeline)
    assert not syntax.should_merge("word " * MAX_PARSE_TOKENS + "the.", "new plan.", "punctuation_model")
    assert pipeline.parse_calls == 0
    assert not syntax.should_merge("x" * 12_001 + " the.", "new plan.", "punctuation_model")
    assert len(pipeline.inputs) == 1


def test_inference_failure_preserves_the_boundary_and_logs_no_source(capsys):
    pipeline = StubPipeline()  # Its invalid annotations cause a parse failure.
    syntax = SentenceSyntax(pipeline)
    assert not syntax.should_merge("private transcript the.", "new plan.", "punctuation_model")
    assert not syntax.should_merge("private transcript the.", "new plan.", "punctuation_model")
    output = capsys.readouterr().out
    assert output.count("sentence_syntax_unavailable") == 1
    assert "inference_failed" in output
    assert "private transcript" not in output


def test_loader_is_shared_by_concurrent_workers_and_keeps_pos_components(monkeypatch):
    calls = []
    pipeline = SimpleNamespace(pipe_names=["tok2vec", "tagger", "parser", "attribute_ruler"])

    def load(name, **kwargs):
        calls.append((name, kwargs))
        return pipeline

    monkeypatch.setitem(sys.modules, "spacy", SimpleNamespace(load=load))
    monkeypatch.setattr(sentence_syntax, "_load_attempted", False)
    monkeypatch.setattr(sentence_syntax, "_engine", None)
    with ThreadPoolExecutor(max_workers=4) as executor:
        engines = list(executor.map(lambda _: get_sentence_syntax("en-US"), range(8)))
    assert all(engine is engines[0] for engine in engines)
    assert engines[0] is not None
    assert calls == [("en_core_web_sm", {"exclude": ["ner", "lemmatizer"]})]
    assert get_sentence_syntax("fr") is None


def test_missing_model_is_a_cached_safe_fallback(monkeypatch, capsys):
    calls = []

    def load(*args, **kwargs):
        calls.append(args)
        raise OSError("do not expose this exception message")

    monkeypatch.setitem(sys.modules, "spacy", SimpleNamespace(load=load))
    monkeypatch.setattr(sentence_syntax, "_load_attempted", False)
    monkeypatch.setattr(sentence_syntax, "_engine", None)
    assert get_sentence_syntax() is None
    assert get_sentence_syntax() is None
    assert len(calls) == 1
    output = capsys.readouterr().out
    assert "model_missing_or_unreadable" in output
    assert "do not expose" not in output


def test_pipeline_without_pos_mapping_is_not_silently_accepted(monkeypatch, capsys):
    pipeline = SimpleNamespace(pipe_names=["tok2vec", "tagger", "parser"])
    monkeypatch.setitem(sys.modules, "spacy", SimpleNamespace(load=lambda *args, **kwargs: pipeline))
    monkeypatch.setattr(sentence_syntax, "_load_attempted", False)
    monkeypatch.setattr(sentence_syntax, "_engine", None)
    assert get_sentence_syntax() is None
    assert "incomplete_pipeline" in capsys.readouterr().out


def test_optional_installed_model_on_hand_authored_quality_pairs():
    # No download and no dependency requirement for the normal test suite.
    if importlib.util.find_spec("spacy") is None or importlib.util.find_spec("en_core_web_sm") is None:
        pytest.skip("Optional local spaCy English model is not installed")
    import spacy

    syntax = SentenceSyntax(spacy.load("en_core_web_sm", exclude=["ner", "lemmatizer"]))
    fixture = json.loads((Path(__file__).parent / "fixtures" / "sentence_syntax_cases.json").read_text())
    failures = []
    for case in fixture["cases"]:
        actual = syntax.should_merge(case["left"], case["right"], "punctuation_model")
        known_abstention = not actual and case["merge"] and case.get("allow_abstain", False)
        if actual != case["merge"] and not known_abstention:
            failures.append(case)
        assert not syntax.should_merge(case["left"], case["right"], "source_punctuation")
    assert not failures
