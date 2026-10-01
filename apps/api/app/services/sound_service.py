"""Conservative text-only connected-speech candidates, never acoustic evidence."""

import hashlib
import re
from collections import OrderedDict
from dataclasses import dataclass
from itertools import islice
from threading import Lock

from app.integrations.cmudict_lexicon import (
    CONSONANTS,
    VOWELS,
    PronunciationLexicon,
    get_pronunciation_lexicon,
)
from app.schemas.sound import SentenceSound, SoundCandidate, SoundCoverage, SoundKind, SoundToken
from app.services.blueprint_service import find_blueprint_sentence, get_blueprint


RULE_VERSION = "sound-rules-v1"
MAX_CHARACTERS = 6000
MAX_TOKENS = 300
MAX_CANDIDATES = 80
MAX_PRONUNCIATIONS = 4
MAX_CACHE_ENTRIES = 128
# Keep contractions, numbers and non-English words whole. Unsupported forms stay
# unknown instead of silently turning part of them into an English word.
_WORDS = re.compile(r"['’]?[^\W_]+(?:['’][^\W_]+)*", re.UNICODE)
_IPA = {
    "AA": "ɑ", "AE": "æ", "AH": "ʌ", "AO": "ɔ", "AW": "aʊ", "AY": "aɪ",
    "EH": "ɛ", "ER": "ɝ", "EY": "eɪ", "IH": "ɪ", "IY": "i", "OW": "oʊ",
    "OY": "ɔɪ", "UH": "ʊ", "UW": "u", "B": "b", "CH": "tʃ", "D": "d",
    "DH": "ð", "F": "f", "G": "ɡ", "HH": "h", "JH": "dʒ", "K": "k", "L": "l",
    "M": "m", "N": "n", "NG": "ŋ", "P": "p", "R": "ɹ", "S": "s", "SH": "ʃ",
    "T": "t", "TH": "θ", "V": "v", "W": "w", "Y": "j", "Z": "z", "ZH": "ʒ",
}
# This whitelist is conditional on grammatical use. It is not a POS or stress
# detector. Ambiguous content-word/auxiliary uses such as "can" are excluded.
_WEAK_FORMS = {
    "a": ("/eɪ/", "/ə/", "Used as an indefinite article, not the letter A or a quoted word."),
    "an": ("/æn/", "/ən/", "Used as an indefinite article, not a name or a quoted word."),
    "and": ("/ænd/", "/ənd/", "Used as a coordinating conjunction, not a quoted word."),
    "of": ("/ʌv/", "/əv/", "Used as a preposition, not a quoted word."),
    "to": ("/tu/", "/tə/", "Used as a preposition or infinitive marker, not a quoted word."),
    "the": ("/ˈði/", "/ðə/", "Used as a definite article, not a quoted word or title."),
}
_cache: OrderedDict[tuple[str, ...], SentenceSound] = OrderedDict()
_cache_lock = Lock()


class SoundInputTooLong(ValueError):
    pass


@dataclass(frozen=True)
class _Word:
    token: SoundToken
    start: int
    end: int


def get_sentence_sound(content_id: str, sentence_id: str) -> SentenceSound | None:
    blueprint = get_blueprint(content_id)
    if blueprint is None:
        return None
    # Use exactly the same derived legacy sentence view as GET /blueprints. Do
    # not interpret sentence IDs as transcript indexes or accept client text.
    line = find_blueprint_sentence(blueprint, sentence_id)
    if line is None:
        return None
    text = "".join(part if isinstance(part, str) else part.text for part in line.parts)
    return annotate_sentence(content_id, sentence_id, text)


def annotate_sentence(content_id: str, sentence_id: str, text: str) -> SentenceSound:
    if len(text) > MAX_CHARACTERS or sum(2 if ord(char) > 0xFFFF else 1 for char in text) > MAX_CHARACTERS:
        raise SoundInputTooLong("Sound annotation supports sentences up to 6000 characters.")
    lexicon = get_pronunciation_lexicon()
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    key = (RULE_VERSION, lexicon.version, content_id, sentence_id, digest)
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key].model_copy(deep=True)
        result = _annotate(content_id, sentence_id, text, lexicon)
        _cache[key] = result
        while len(_cache) > MAX_CACHE_ENTRIES:
            _cache.popitem(last=False)
        return result.model_copy(deep=True)


def _symbol(phone: str) -> str:
    if phone == "AH0":
        return "ə"
    if phone == "ER0":
        return "ɚ"
    return _IPA[phone.rstrip("012")]


def _ipa(phones: tuple[str, ...] | list[str]) -> str:
    # Broad segment symbols only. Stress is retained explicitly in ARPABET;
    # placing IPA stress correctly would require a syllabification model.
    return "/" + "".join(_symbol(phone) for phone in phones) + "/"


def _annotate(content_id: str, sentence_id: str, text: str, lexicon: PronunciationLexicon) -> SentenceSound:
    matches = list(islice(_WORDS.finditer(text), MAX_TOKENS + 1))
    utf16 = [0]
    for character in text:
        utf16.append(utf16[-1] + (2 if ord(character) > 0xFFFF else 1))
    words: list[_Word] = []
    variants_truncated = False
    for index, match in enumerate(matches[:MAX_TOKENS]):
        surface = match.group()
        variants = lexicon.words.get(surface.replace("’", "'").casefold(), ())
        # Uppercase initialisms/acronyms may share a spelling with an ordinary
        # word (SAT/sat, IT/it). Without an explicit acronym policy, do not pick
        # that word's pronunciation. I retains its ordinary pronoun reading;
        # uppercase A could be a letter or an article and remains unresolved.
        if surface == "A" or (surface.isupper() and sum(char.isalpha() for char in surface) > 1):
            variants = ()
        # Digit strings and mixed scripts have no reliable spoken expansion.
        if not re.fullmatch(r"'?\b[a-z]+(?:'[a-z]+)*", surface.replace("’", "'").casefold()):
            variants = ()
        variants_truncated |= len(variants) > MAX_PRONUNCIATIONS
        shown = variants[:MAX_PRONUNCIATIONS]
        words.append(_Word(
            token=SoundToken(
                index=index, text=surface, start=utf16[match.start()], end=utf16[match.end()],
                pronunciations=[list(phones) for phones in shown], ipa=[_ipa(phones) for phones in shown],
                status="unknown" if not variants else "known" if len(variants) == 1 else "ambiguous",
            ),
            start=match.start(), end=match.end(),
        ))

    candidates: list[SoundCandidate] = []
    def add(kind: SoundKind, start: int, end: int, before: str, after: str,
            explanation: str, conditions: list[str], rule_id: str) -> None:
        # One extra result records truncation without accumulating more output.
        if len(candidates) > MAX_CANDIDATES:
            return
        candidates.append(SoundCandidate(
            id=f"{rule_id}:{start}:{end}", kind=kind, token_start=start, token_end=end,
            source_text=text[words[start].start:words[end - 1].end],
            phonemes_before=before, phonemes_after=after, explanation=explanation,
            conditions=conditions, rule_id=rule_id,
        ))

    for index, word in enumerate(words):
        token = word.token
        following = words[index + 1] if index + 1 < len(words) else None
        joined = following is not None and text[word.end:following.start].isspace()
        previous_joined = index > 0 and text[words[index - 1].end:word.start].isspace()
        form = _WEAK_FORMS.get(token.text)
        if form and token.status != "unknown" and previous_joined and joined:
            before, after, grammar = form
            extra: list[str] = []
            eligible = True
            if token.text in {"the", "to"}:
                # Do not select a following-vowel variant by spelling alone.
                eligible = following.token.status == "known"
                if eligible:
                    next_vowel = following.token.pronunciations[0][0].rstrip("012") in VOWELS
                    if token.text == "the" and next_vowel:
                        after = "/ði/"
                        extra.append("The next word begins with a vowel sound; this weak form has a short vowel.")
                    elif token.text == "to" and next_vowel:
                        eligible = False
            if eligible:
                add("weak_form", index, index + 1, before, after,
                    "This function word may use a weak form in connected speech.",
                    [grammar, "The word is unstressed and is not being contrasted or emphasized.",
                     "No phrase boundary or deliberate pause separates it from the surrounding words.", *extra],
                    "weak-function-v1")

        if token.status != "known":
            continue
        phones = token.pronunciations[0]
        for position in range(1, len(phones) - 1):
            if (phones[position] in {"T", "D"}
                    and phones[position - 1].endswith("1")
                    and phones[position - 1][:-1] in VOWELS
                    and phones[position + 1].endswith("0")
                    and phones[position + 1][:-1] in VOWELS):
                left, right = _symbol(phones[position - 1]), _symbol(phones[position + 1])
                add("flap", index, index + 1,
                    f"/{left}{_symbol(phones[position])}{right}/", f"[{left}ɾ{right}]",
                    "An internal /t/ or /d/ may become an alveolar tap in this American English environment.",
                    ["The preceding vowel has primary lexical stress and the following vowel is unstressed in the dictionary.",
                     "The speaker uses a dialect and speaking style that permits tapping; careful emphasis may preserve the stop."],
                    f"flap-v1-p{position}")

        if not joined or following.token.status != "known":
            continue
        next_phones = following.token.pronunciations[0]
        last, first = phones[-1], next_phones[0]
        if last in CONSONANTS and first.rstrip("012") in VOWELS:
            add("linking", index, index + 2, f"/{_symbol(last)} + {_symbol(first)}/",
                f"[{_symbol(last)}‿{_symbol(first)}]",
                "The final consonant may connect directly to the following vowel sound.",
                ["The words belong to the same spoken phrase without a pause or a new glottal onset."],
                "link-cv-v1")
        if last in {"T", "D"} and first == "Y" and following.token.text.casefold() in {"you", "your"}:
            add("assimilation", index, index + 2, f"/{_symbol(last)} + j/",
                "[tʃ]" if last == "T" else "[dʒ]",
                "The word-final stop and the initial /j/ of the pronoun may coalesce.",
                ["The pronoun is unstressed and immediately follows in the same spoken phrase.",
                 "The speaker uses a style that permits coalescence; both separate sounds are also possible."],
                "coalescence-pronoun-v1")
        if len(phones) >= 2 and last in {"T", "D"} and phones[-2] in CONSONANTS and first in CONSONANTS:
            add("elision", index, index + 2, f"/{_symbol(phones[-2])} {_symbol(last)} # {_symbol(first)}/",
                f"[{_symbol(phones[-2])} {_symbol(first)}]",
                "The final /t/ or /d/ in this consonant cluster may be omitted in connected speech.",
                ["The words are in the same phrase and the speaker uses a style that permits cluster simplification.",
                 "Omission is optional; keeping the stop is also valid. An unreleased stop is not evidence of deletion."],
                "cluster-elision-v1")

    warnings = [
        "These are conditional text-rule candidates, not observations of the reference audio or the learner's pronunciation.",
        "Dictionary stress is lexical stress, not sentence emphasis. IPA shows broad segment symbols without syllabification or stress marks.",
        "Candidates are independent possibilities, not a combined required pronunciation. No accuracy percentage or score is assigned.",
    ]
    if any(word.token.status == "unknown" for word in words):
        warnings.append("Unknown words, names, numbers, uppercase acronym forms and unsupported forms have no guessed pronunciation; their phone rules are skipped.")
    if any(word.token.status == "ambiguous" for word in words):
        warnings.append("Words with multiple dictionary pronunciations are ambiguous; phone rules skip them. Whitelisted grammatical weak forms remain conditional.")
    if len(matches) > MAX_TOKENS:
        warnings.append("Only the first 300 tokens were annotated; remaining sentence tokens were skipped.")
    if len(candidates) > MAX_CANDIDATES:
        warnings.append("Only the first 80 candidates are shown; additional candidates were omitted.")
    if variants_truncated:
        warnings.append("At most four dictionary pronunciations per token are shown; additional variants were omitted and the token remains ambiguous.")
    return SentenceSound(
        content_id=content_id, sentence_id=sentence_id, sentence_text=text, lexicon_version=lexicon.version,
        tokens=[word.token for word in words], candidates=candidates[:MAX_CANDIDATES],
        coverage=SoundCoverage(known=sum(word.token.status == "known" for word in words), total=len(words)),
        warnings=warnings,
    )
