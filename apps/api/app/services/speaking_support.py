"""Pure support-setting and conservative expression-variant rules."""
from __future__ import annotations

import re
import unicodedata


SUPPORT_LEVELS = frozenset({"model_frame", "model_label", "label_only", "no_hint"})
MODELING_LEVELS = frozenset({"model_frame", "model_label"})
AUTOMATIC_ACTIONS = frozenset({"implicit_elicitation", "model_then_transfer"})
_WORDS = re.compile(r"\w+(?:['’]\w+)*", re.UNICODE)
_CONTRACTIONS = {"i'm": ["i", "am"], "it's": ["it", "is"], "isn't": ["is", "not"],
                 "don't": ["do", "not"], "can't": ["can", "not"], "we're": ["we", "are"],
                 "that's": ["that", "is"], "i've": ["i", "have"], "we've": ["we", "have"]}


def effective_support(session, document: dict) -> dict | None:
    """Return the current explicit setting; absence preserves legacy behavior."""
    state = document.get("support")
    if (isinstance(state, dict) and isinstance(state.get("level"), str) and state["level"] in SUPPORT_LEVELS
            and type(state.get("version")) is int and state["version"] >= 0):
        return {"level": state["level"], "version": state["version"]}
    level = getattr(session, "support_level", None)
    return {"level": level, "version": 0} if isinstance(level, str) and level in SUPPORT_LEVELS else None


def support_matches(policy: dict, session, document: dict) -> bool:
    support = effective_support(session, document)
    if support is None:
        return policy.get("support_level") is None and policy.get("support_version") is None
    return (policy.get("support_level") == support["level"]
            and type(policy.get("support_version")) is int
            and policy["support_version"] == support["version"])


def _variant_words(text: str) -> list[str]:
    tokens = [unicodedata.normalize("NFKC", match.group()).casefold().replace("’", "'")
              for match in _WORDS.finditer(text)]
    words = [part for word in tokens for part in _CONTRACTIONS.get(word, [word])]
    return [word[:-1] if len(word) > 4 and word.endswith("s") else word for word in words]


def variant_supported(expression: str, quote: str) -> bool:
    """Match the existing Stage 5 contraction/inflection rule, not paraphrases."""
    expected = _variant_words(expression)
    return bool(expected) and expected == _variant_words(quote)


def find_variant_quote(text: str, expression: str) -> str | None:
    """Find a contiguous original quote for exposure only, never model reflection."""
    expected = _variant_words(expression)
    if not expected:
        return None
    tokens = list(_WORDS.finditer(text))
    expanded = [(word, index) for index, token in enumerate(tokens)
                for word in _variant_words(token.group())]
    size = len(expected)
    for start in range(len(expanded) - size + 1):
        end = start + size
        first, last = expanded[start][1], expanded[end - 1][1]
        # Never match only one half of a contraction such as "am" inside "I'm".
        if ((start and expanded[start - 1][1] == first)
                or (end < len(expanded) and expanded[end][1] == last)):
            continue
        if [word for word, _ in expanded[start:end]] != expected:
            continue
        selected = tokens[first:last + 1]
        if any(not re.fullmatch(r"[\s,\-–—]*", text[left.end():right.start()])
               for left, right in zip(selected, selected[1:])):
            continue
        return text[selected[0].start():selected[-1].end()]
    return None
