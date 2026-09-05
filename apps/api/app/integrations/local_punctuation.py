import json
from functools import lru_cache
from pathlib import Path
from typing import Protocol

from app.config import get_settings


MODEL_NAME = "sherpa-onnx-online-punct-en-2024-08-06"
DEFAULT_MODEL_DIR = Path(__file__).resolve().parents[2] / ".models" / MODEL_NAME


class PunctuationEngine(Protocol):
    def add_punctuation(self, text: str) -> str: ...


class SherpaOnnxPunctuationEngine:
    def __init__(self, punctuation: object) -> None:
        self._punctuation = punctuation

    def add_punctuation(self, text: str) -> str:
        add_punctuation = getattr(self._punctuation, "add_punctuation_with_case")
        return str(add_punctuation(text))


def get_punctuation_engine(language: str | None) -> PunctuationEngine | None:
    if language and language.split("-", maxsplit=1)[0].casefold() != "en":
        return None

    settings = get_settings()
    model_path = Path(settings.punctuation_model_path) if settings.punctuation_model_path else DEFAULT_MODEL_DIR / "model.int8.onnx"
    vocab_path = Path(settings.punctuation_bpe_vocab_path) if settings.punctuation_bpe_vocab_path else DEFAULT_MODEL_DIR / "bpe.vocab"
    if not model_path.is_file() or not vocab_path.is_file():
        return None
    return _load_sherpa_engine(str(model_path), str(vocab_path), settings.punctuation_num_threads)


@lru_cache(maxsize=4)
def _load_sherpa_engine(
    model_path: str,
    vocab_path: str,
    num_threads: int,
) -> PunctuationEngine | None:
    try:
        import sherpa_onnx

        model_config = sherpa_onnx.OnlinePunctuationModelConfig(
            cnn_bilstm=model_path,
            bpe_vocab=vocab_path,
            num_threads=num_threads,
            provider="cpu",
        )
        config = sherpa_onnx.OnlinePunctuationConfig(model_config=model_config)
        return SherpaOnnxPunctuationEngine(sherpa_onnx.OnlinePunctuation(config))
    except Exception as error:
        print(
            json.dumps(
                {
                    "event": "punctuation_model_unavailable",
                    "exception_type": type(error).__name__,
                },
                separators=(",", ":"),
            ),
            flush=True,
        )
        return None
