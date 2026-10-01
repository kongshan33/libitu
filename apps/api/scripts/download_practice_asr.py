"""Provision the pinned ASR model explicitly; analysis requests never download models."""
import argparse
import os
from pathlib import Path

from app.services.acoustics.transcribe import model_fingerprint


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    from huggingface_hub import snapshot_download
    snapshot_download("Systran/faster-whisper-small.en", revision="d1d751a5f8271d482d14ca55d9e2deeebbae577f",
        local_dir=args.output, allow_patterns=["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"], max_workers=2)
    print(f"PRACTICE_ASR_MODEL_PATH={args.output.resolve()}")
    print(f"PRACTICE_ASR_MODEL_SHA256={model_fingerprint(args.output)}")


if __name__ == "__main__":
    main()
