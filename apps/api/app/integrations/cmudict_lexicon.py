"""Pinned local CMUdict data; no network, model or pronunciation guessing."""

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from types import MappingProxyType
from typing import Mapping


LEXICON_VERSION = "cmudict-74790861f652"
LEXICON_SHA256 = "81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22"
LEXICON_PATH = Path(__file__).resolve().parents[1] / "data" / "cmudict" / "cmudict.dict"
VOWELS = frozenset("AA AE AH AO AW AY EH ER EY IH IY OW OY UH UW".split())
CONSONANTS = frozenset("B CH D DH F G HH JH K L M N NG P R S SH T TH V W Y Z ZH".split())
_VARIANT = re.compile(r"\(\d+\)$")
_PHONE = re.compile(r"(?:AA|AE|AH|AO|AW|AY|EH|ER|EY|IH|IY|OW|OY|UH|UW)[012]$")


class LexiconUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class PronunciationLexicon:
    version: str
    words: Mapping[str, tuple[tuple[str, ...], ...]]


_lexicon: PronunciationLexicon | None = None
_lexicon_lock = Lock()


def get_pronunciation_lexicon() -> PronunciationLexicon:
    """Load and verify once; absence/corruption fails visibly, without fallback."""
    global _lexicon
    with _lexicon_lock:
        if _lexicon is not None:
            return _lexicon
        try:
            data = LEXICON_PATH.read_bytes()
            if hashlib.sha256(data).hexdigest() != LEXICON_SHA256:
                raise ValueError("Unexpected dictionary checksum")
            words: dict[str, list[tuple[str, ...]]] = {}
            for line in data.decode("utf-8").splitlines():
                fields = line.split("#", 1)[0].split()
                if not fields:
                    continue
                word, *phones = fields
                if not phones or any(phone not in CONSONANTS and not _PHONE.fullmatch(phone) for phone in phones):
                    raise ValueError("Invalid dictionary phones")
                key = _VARIANT.sub("", word).casefold()
                pronunciation = tuple(phones)
                variants = words.setdefault(key, [])
                if pronunciation not in variants:
                    variants.append(pronunciation)
            if len(words) < 100_000:
                raise ValueError("Incomplete dictionary")
            _lexicon = PronunciationLexicon(
                version=LEXICON_VERSION,
                words=MappingProxyType({word: tuple(variants) for word, variants in words.items()}),
            )
        except (OSError, UnicodeError, ValueError) as error:
            raise LexiconUnavailable("Sound dictionary is unavailable. Restore the pinned CMUdict data.") from error
        return _lexicon
