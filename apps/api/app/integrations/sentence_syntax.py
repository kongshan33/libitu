"""Optional local syntax evidence for merging caption sentence candidates.

This adapter never generates text or splits a sentence. A positive decision is
deliberately narrow: a dependency must cross the proposed boundary and explain
an incomplete edge. spaCy's sentence iterator alone is not a completeness test.
"""

import json
import re
from threading import Lock
from typing import Any


MODEL_NAME = "en_core_web_sm"
MAX_PARSE_TOKENS = 256
MAX_PARSE_CHARACTERS = 12_000
_BOUNDARY_MARKS = re.compile(r"[.!?]+\s*$")
_WORDS = re.compile(r"[A-Za-z]+(?:['’][A-Za-z]+)?")
_SUBORDINATORS = frozenset({
    "although", "though", "because", "if", "unless", "when", "while",
    "whereas", "since", "after", "before", "until", "once",
})
_EDGE_WORDS = _SUBORDINATORS | frozenset({
    "and", "or", "but", "that", "which", "who", "whose", "whom",
    "to", "of", "for", "with", "at", "by", "from", "into", "through",
    "about", "on", "in", "the", "a", "an", "my", "your", "our", "their",
    "can", "could", "will", "would", "should", "must", "have", "has",
    "had", "is", "are", "was", "were", "be", "been", "being",
})
_CONTINUATIONS = _SUBORDINATORS | frozenset({
    "which", "who", "whose", "whom", "that", "to", "and", "or", "but",
    "is", "are", "was", "were", "has", "have", "had",
})
_ANSWER_WORDS = frozenset({
    "yes", "no", "okay", "ok", "exactly", "absolutely", "certainly",
    "definitely", "perhaps", "maybe", "sure", "thanks", "thank",
})


class SentenceSyntax:
    """Conservative English merge decisions backed by an injected spaCy pipeline."""

    def __init__(self, pipeline: Any) -> None:
        self._pipeline = pipeline
        # The shared Language object/vocabulary is used by concurrent workers.
        self._parse_lock = Lock()
        self._failure_reported = False

    def should_merge(self, left: str, right: str, boundary_source: str) -> bool:
        left = left.strip()
        right = right.strip()
        if not left or not right:
            return False
        # Authored punctuation and question/answer turns outweigh uncertain
        # syntax. Questions remain complete even when they end in a preposition.
        if boundary_source == "source_punctuation" or left.rstrip('"”\'’)]').endswith(("?", "!")):
            return False
        if right.rstrip('"”\'’)]').endswith("?"):
            return False
        if boundary_source not in {"punctuation_model", "length_guard", "caption_pause"}:
            return False
        if len(left) + len(right) > MAX_PARSE_CHARACTERS:
            return False

        left_words = [word.casefold() for word in _WORDS.findall(left)]
        right_words = [word.casefold() for word in _WORDS.findall(right)]
        if not left_words or not right_words:
            return False
        if left_words[0] in _ANSWER_WORDS or right_words[0] in _ANSWER_WORDS:
            return False
        if len(right_words) > 1 and right_words[0] in {"and", "but", "or"} and right_words[1] in {
            "i", "we", "you", "he", "she", "they", "it",
        }:
            # Explicit subjects signal a new coordinated statement. In noisy
            # "And I. think ..." captions the stray period can make the parser
            # miss that subject and falsely infer a shared-subject predicate.
            return False
        if not (
            left_words[-1] in _EDGE_WORDS
            or left_words[0] in _SUBORDINATORS
            or right_words[0] in _CONTINUATIONS
        ):
            return False

        # Remove only the disputed mark. Known function words lose sentence-
        # initial capitalization in inference input; names and source output do
        # not change. Otherwise "The city I grew up in. Is changing" is often
        # misparsed solely because the capitalized auxiliary looks like a start.
        prefix = _BOUNDARY_MARKS.sub("", left).rstrip()
        if left_words[0] in _SUBORDINATORS and "," not in prefix:
            # Test the ordinary clause-joining punctuation for an opening
            # conditional; the dependency must still connect to a matrix verb
            # on the right. This comma is never emitted into the transcript.
            prefix += ","
        continuation = right
        if right_words[0] in _CONTINUATIONS and right[:1].isupper():
            continuation = right[:1].lower() + right[1:]
        text = f"{prefix} {continuation}"
        boundary = len(prefix)
        try:
            with self._parse_lock:
                doc = self._pipeline.make_doc(text)
                if len(doc) > MAX_PARSE_TOKENS:
                    return False
                doc = self._pipeline(doc)
            if not doc.has_annotation("DEP"):
                return False
            before = [token for token in doc if token.idx < boundary and not token.is_punct and not token.is_space]
            after = [token for token in doc if token.idx > boundary and not token.is_punct and not token.is_space]
            if not before or not after:
                return False
            if before[-1].pos_ == "ADP" and len(before) > 1 and any(
                token.dep_ in {"pobj", "pcomp"} and token.head.i == before[-1].i for token in after
            ):
                # Removing a period can incorrectly turn the adverb in "earlier
                # on. One." or a phrasal-verb particle into a preposition. Check
                # that its isolated left parse also supports a missing object.
                with self._parse_lock:
                    isolated = self._pipeline(self._pipeline.make_doc(left))
                edge = [token for token in isolated if not token.is_punct and not token.is_space][-1]
                if edge.pos_ != "ADP" or edge.dep_ == "prt":
                    return False
            return self._has_incomplete_edge(before, after, boundary, len(left_words))
        except Exception as error:
            # Never log exceptions' messages: some NLP errors include the input.
            if not self._failure_reported:
                self._failure_reported = True
                _log_unavailable("inference_failed", error)
            return False

    @staticmethod
    def _has_incomplete_edge(before: list[Any], after: list[Any], boundary: int, left_word_count: int) -> bool:
        last = before[-1]
        first = after[0]
        if last.pos_ == "AUX" and left_word_count <= 4:
            return False
        if last.lower_ == "to" and last.dep_ == "xcomp" and last.head.idx < boundary:
            return False
        if first.lower_ == "that" and first.dep_ in {"nsubj", "nsubjpass", "expl"}:
            # "That will work." and "That is ..." can stand independently.
            # Removing the boundary often makes the parser attach a perfectly
            # valid demonstrative sentence as a relative clause of a left noun.
            return False

        # A determiner, subordinator, or infinitival "to" whose missing head is
        # in the next candidate is strong local evidence, unlike mere brevity.
        if last.dep_ in {"det", "poss", "mark", "aux"} and last.head.idx > boundary:
            if last.pos_ != "AUX":
                return True
            # "I can." / "They have." are valid ellipsis. Only a longer noun
            # subject followed by a main predicate provides useful AUX evidence.
            if left_word_count > 4 and not any(token.pos_ == "VERB" for token in before):
                return True
        if last.pos_ == "ADP" and any(
            token.dep_ in {"pobj", "pcomp"} and token.head.i == last.i for token in after
        ):
            # Do not mistake the stranded preposition in "the person I spoke
            # with" for an unfinished object when the object is already left.
            return not any(token.dep_ in {"pobj", "pcomp"} and token.head.i == last.i for token in before)
        if last.pos_ == "CCONJ" and last.dep_ == "cc" and any(
            token.dep_ == "conj" and token.head.idx < boundary for token in after
        ):
            return True

        # "Although demand recovered. We remain cautious." is one clause plus
        # its matrix clause only when the parse connects them as such.
        if before[0].lower_ in _SUBORDINATORS and before[0].dep_ in {"mark", "advmod"}:
            clause = before[0].head
            if clause.dep_ == "advcl" and clause.head.idx > boundary:
                return True

        # Only dependent roots continuing the left candidate count. Independent
        # clauses beginning "That", "And", or "To be honest" do not qualify.
        if first.lower_ in _CONTINUATIONS:
            has_right_matrix_clause = any(
                token.dep_ == "ROOT" and any(
                    child.dep_ in {"nsubj", "nsubjpass", "csubj", "expl"}
                    and child.idx > boundary for child in token.children
                ) for token in after
            )
            if has_right_matrix_clause:
                return False
            if any(token.dep_ == "relcl" and token.head.idx < boundary for token in after):
                return first.lower_ in {"which", "who", "whose", "whom", "that"}
            # A new If/When/etc candidate may open its own conditional sentence.
            # Keep it pending for its following matrix clause, not attached to
            # a preceding complete statement. Causal Because is a narrower
            # backwards continuation (question-answer boundaries are guarded).
            if first.lower_ == "because" and first.dep_ == "mark":
                clause = first.head
                if clause.dep_ == "advcl" and clause.head.idx < boundary:
                    return True
            if first.lower_ == "to" and first.dep_ == "aux":
                return first.head.dep_ in {"xcomp", "advcl"} and first.head.head.idx < boundary
            if first.pos_ == "CCONJ" and any(
                token.dep_ == "conj" and token.head.idx < boundary and token.pos_ in {"VERB", "AUX"}
                and not any(child.dep_ in {"nsubj", "nsubjpass", "csubj", "expl"} for child in token.children)
                for token in after
            ):
                return True
            # A longer noun phrase can have relative-clause verbs but still be
            # waiting for its matrix predicate; do not reject such subjects.
            if left_word_count >= 4 and first.pos_ in {"AUX", "VERB"}:
                return any(
                    token.dep_ in {"nsubj", "nsubjpass"} and token.head.idx > boundary
                    for token in before
                ) and not any(token.dep_ == "ROOT" for token in before)
        return False


_engine: SentenceSyntax | None = None
_load_attempted = False
_load_lock = Lock()


def get_sentence_syntax(language: str | None = "en") -> SentenceSyntax | None:
    """Load a locally installed small English model once; never download assets."""
    if language and language.replace("_", "-").split("-", maxsplit=1)[0].casefold() != "en":
        return None
    global _engine, _load_attempted
    with _load_lock:
        if _load_attempted:
            return _engine
        _load_attempted = True
        try:
            import spacy

            pipeline = spacy.load(MODEL_NAME, exclude=["ner", "lemmatizer"])
            if not {"tok2vec", "tagger", "parser", "attribute_ruler"}.issubset(pipeline.pipe_names):
                _log_unavailable("incomplete_pipeline")
                return None
            _engine = SentenceSyntax(pipeline)
        except ImportError as error:
            _log_unavailable("dependency_missing", error)
        except OSError as error:
            _log_unavailable("model_missing_or_unreadable", error)
        except Exception as error:
            _log_unavailable("model_load_failed", error)
        return _engine


def _log_unavailable(cause: str, error: Exception | None = None) -> None:
    print(json.dumps({
        "event": "sentence_syntax_unavailable",
        "cause": cause,
        "model": MODEL_NAME,
        "exception_type": type(error).__name__ if error else None,
    }, separators=(",", ":")), flush=True)
