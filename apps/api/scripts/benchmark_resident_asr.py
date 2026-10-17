"""Offline one-shot vs resident ASR; same pinned model/parameters and input WAV.

Run from apps/api: .venv/bin/python -m scripts.benchmark_resident_asr
  --audio /path/audio.wav --text-file /path/expected.txt --runs 3
Only timing, tier and evidence hashes are printed; no audio/transcripts uploaded.
"""
import argparse
from hashlib import sha256
import json
from pathlib import Path
from statistics import median
import subprocess
import sys
from tempfile import TemporaryDirectory
from time import perf_counter

from app.config import get_settings
from app.services.acoustics.practice_prosody import normalize_take
from app.services.acoustics.transcribe import close_resident, transcribe, verify_model, warm_up
from app.services.acoustics.word_check import check_words


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audio', required=True, type=Path)
    parser.add_argument('--text-file', required=True, type=Path)
    parser.add_argument('--runs', type=int, default=3)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error('--runs must be positive')
    settings = get_settings()
    verify_model(settings.practice_asr_model_path, settings.practice_asr_model_sha256)
    text = args.text_file.read_text().strip()
    rows = []
    try:
        with TemporaryDirectory(prefix='libitu-asr-benchmark-') as tmp:
            wav = Path(tmp)/'input.wav'
            duration = normalize_take(args.audio, wav)
            for mode in ('one_shot', 'resident'):
                startup = None
                if mode == 'resident':
                    started = perf_counter(); warm_up(settings); startup = perf_counter()-started
                elapsed, hashes, tiers = [], [], []
                for _ in range(args.runs):
                    started = perf_counter()
                    if mode == 'one_shot':
                        response = subprocess.run([sys.executable, '-m', 'app.services.acoustics.transcribe',
                            '--audio', str(wav), '--model', settings.practice_asr_model_path],
                            capture_output=True, check=True, timeout=180)
                        result = json.loads(response.stdout)
                    else:
                        result = transcribe(wav, settings)
                    elapsed.append(round(perf_counter()-started, 3))
                    check = check_words(text, result)
                    hashes.append(sha256(json.dumps([result, check.model_dump(mode='json')], sort_keys=True).encode()).hexdigest())
                    tiers.append(check.tier)
                row = dict(mode=mode, audio_seconds=duration, runs_seconds=elapsed,
                    median_seconds=median(elapsed), startup_seconds=round(startup, 3) if startup is not None else None,
                    evidence_sha256=hashes, tiers=tiers)
                rows.append(row)
                print(json.dumps(row), flush=True)
            print(json.dumps({'identical_evidence': len({h for row in rows for h in row['evidence_sha256']}) == 1,
                              'excludes': ['upload', 'queue', 'MFA', 'comparison', 'UI_polling']}))
    finally:
        close_resident()


if __name__ == '__main__':
    main()
