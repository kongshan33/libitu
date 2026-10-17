"""Versioned, bounded sequence checks against independently recognized words."""
import re
import unicodedata
import math
from app.schemas.signal_prosody import WordBoundary

from app.schemas.practice_analysis import AnalysisScope, CheckedToken, ContentCheck, WordCheck, WordEdit

MAX_TOKENS = 1024
TOKEN = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)*")


def checked_tokens(text: str) -> list[CheckedToken]:
    # Normalize combining clusters while retaining offsets into the original text.
    normalized, origins = [], []
    start = 0
    while start < len(text):
        end = start + 1
        while end < len(text) and unicodedata.combining(text[end]):
            end += 1
        value = unicodedata.normalize("NFKC", text[start:end]).lower().replace("’", "'")
        normalized.append(value)
        origins.extend([(start, end)] * len(value))
        start = end
    joined = "".join(normalized)
    return [CheckedToken(normalized=m.group(), display=text[origins[m.start()][0]:origins[m.end()-1][1]],
                         start=origins[m.start()][0], end=origins[m.end()-1][1])
            for m in TOKEN.finditer(joined)]


def check_words(text: str, recognized: dict) -> WordCheck:
    transcript = recognized.get("text", "")
    source, actual = checked_tokens(text), checked_tokens(transcript)
    result = WordCheck(status="uncertain", transcript=transcript, source_tokens=source,
                       recognized_tokens=actual, source_count=len(source))
    if not source:
        result.status, result.reason = "unavailable", "source_words_unavailable"
        return result
    if max(len(source), len(actual)) > MAX_TOKENS:
        result.status, result.reason = "unavailable", "word_check_limit_exceeded"
        return result
    if not recognized.get("reliable") or not actual:
        result.reason = "recognition_uncertain"
        return result
    # Minimize edits, then maximize exact matches. Candidate order fixes final ties.
    width = len(actual) + 1
    actions = [bytearray(width) for _ in range(len(source)+1)]
    previous = [(j, 0) for j in range(width)]
    actions[0][1:] = bytes([2]) * len(actual)
    for i, token in enumerate(source, 1):
        current = [(i, 0)]
        actions[i][0] = 1
        for j, heard in enumerate(actual, 1):
            same = token.normalized == heard.normalized
            choices = [(previous[j-1][0] + (not same), previous[j-1][1] - same),
                       (previous[j][0]+1, previous[j][1]), (current[j-1][0]+1, current[j-1][1])]
            choice = min(range(3), key=choices.__getitem__)
            actions[i][j] = choice
            current.append(choices[choice])
        previous = current
    i, j = len(source), len(actual)
    operations = []
    while i or j:
        action = actions[i][j]
        if action == 0:
            operations.append(WordEdit(kind="matched" if source[i-1].normalized == actual[j-1].normalized else "substituted",
                                       source_index=i-1, recognized_index=j-1))
            i, j = i-1, j-1
        elif action == 1:
            operations.append(WordEdit(kind="omitted", source_index=i-1))
            i -= 1
        else:
            operations.append(WordEdit(kind="inserted", recognized_index=j-1, source_boundary=i))
            j -= 1
    result.operations = list(reversed(operations))
    result.matched_count = sum(op.kind == "matched" for op in operations)
    result.status = "reliable"
    result.tier = ("below_60" if result.matched_count*100 < result.source_count*60 else
                   "partial_60_85" if result.matched_count*100 < result.source_count*85 else "full_85_plus")
    # Word timing is optional evidence and never changes recognition or its tier.
    # Reject ambiguous tokenization/overlaps instead of inventing word boundaries.
    timed = recognized.get("words") or []
    previous = 0.
    boundaries = []
    for item in timed:
        tokens = checked_tokens(item.get("text", ""))
        a, b = item.get("start_sec"), item.get("end_sec")
        if len(tokens) != 1 or not isinstance(a, (int,float)) or not isinstance(b, (int,float)) \
                or not math.isfinite(a+b) or a < previous or b <= a:
            boundaries = []
            break
        boundaries.append(WordBoundary(text=tokens[0].normalized, start_sec=a, end_sec=b))
        previous = b
    if [b.text for b in boundaries] == [t.normalized for t in actual]:
        result.word_timings = boundaries
    return WordCheck.model_validate(result.model_dump())


def analysis_scope(check: WordCheck) -> AnalysisScope:
    if check.status != "reliable":
        return "none"
    return {"below_60": "none", "partial_60_85": "sound_only", "full_85_plus": "all_layers"}.get(check.tier, "none")


def content_check(check: WordCheck) -> ContentCheck:
    if check.status != "reliable":
        return ContentCheck(status="uncertain" if check.status == "uncertain" else "unavailable",
                            transcript=check.transcript, reason=check.reason)
    exact = all(op.kind == "matched" for op in check.operations)
    return ContentCheck(status="matched" if exact else "mismatch", transcript=check.transcript,
                        reason=None if exact else "recognized_words_differ")
