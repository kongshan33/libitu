"""Offline, same-input comparison of old per-job MFA setup and cached setup.

Run from apps/api with --audio and --text-file. No storage/queue mutations or uploads.
The old setup is reproduced using the same pinned engines, with verification and
lexicon compilation repeated for every job. Run without concurrent builds/tests.
"""
import argparse
from contextlib import contextmanager, nullcontext
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from time import perf_counter

from app.config import get_settings
from app.services.acoustics import engine, mfa_runtime, practice_prosody
from app.services.acoustics.transcribe import warm_up, close_resident
from app.services.acoustics.practice_prosody import normalize_take, check_learner_words, analyze_checked_voice
from app.services.acoustics.reference_prosody import analyze_reference
from app.services.acoustics.word_check import analysis_scope


@contextmanager
def mode(baseline, timings):
    original = (mfa_runtime.lexicon_cache, mfa_runtime._verified, mfa_runtime._version, subprocess.run)
    original_align = engine.align
    original_transcribe = practice_prosody.transcribe
    if baseline:
        mfa_runtime.lexicon_cache = lambda *args: nullcontext()
        mfa_runtime._verified = original[1].__wrapped__
        mfa_runtime._version = original[2].__wrapped__
        # Preserve the historical per-job version probe in the baseline only.
        def align(wav, text, origin, directory, settings):
            mfa_runtime.check_startup(settings)
            return original_align(wav, text, origin, directory, settings)
        engine.align = align
        def one_shot(audio, settings):
            response = subprocess.run([sys.executable, '-m', 'app.services.acoustics.transcribe',
                '--audio', str(audio), '--model', settings.practice_asr_model_path],
                capture_output=True, check=True, timeout=180)
            return json.loads(response.stdout)
        practice_prosody.transcribe = one_shot

    def run(command, *args, **kwargs):
        if baseline:
            command = ['--clean' if value == '--no_clean' else value for value in command]
        start = perf_counter()
        try:
            return original[3](command, *args, **kwargs)
        finally:
            step = command[1] if len(command) > 1 and command[1] in ('version', 'align_one') else 'asr_or_decode'
            timings.append({'step': step, 'seconds': round(perf_counter()-start, 3)})

    subprocess.run = run
    try:
        yield
    finally:
        mfa_runtime.lexicon_cache, mfa_runtime._verified, mfa_runtime._version, subprocess.run = original
        engine.align = original_align
        practice_prosody.transcribe = original_transcribe


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audio', required=True, type=Path)
    parser.add_argument('--text-file', required=True, type=Path)
    args = parser.parse_args()
    settings = get_settings()
    mfa_runtime.check_startup(settings)
    text = args.text_file.read_text(encoding='utf-8').strip()
    outputs = []
    with TemporaryDirectory(prefix='libitu-latency-') as tmp:
        root = Path(tmp); wav = root/'audio.wav'
        duration = normalize_take(args.audio, wav)
        for name in ('baseline', 'optimized'):
            if name == 'optimized':
                warm_up(settings)
            timings = []; directory = root/name
            with mode(name == 'baseline', timings):
                start = perf_counter()
                reference = analyze_reference(wav, text, directory/'reference', settings)
                ref_seconds = perf_counter()-start
                start = perf_counter()
                check = check_learner_words(wav, text, settings)
                check_seconds = perf_counter()-start
                start = perf_counter()
                learner = analyze_checked_voice(wav, check, analysis_scope(check), directory/'learner', settings)
                acoustic_seconds = perf_counter()-start
            evidence = json.dumps([reference.model_dump(mode='json'), check.model_dump(mode='json'),
                                   learner.model_dump(mode='json')], sort_keys=True)
            result = {'mode': name, 'audio_seconds': duration, 'reference_seconds': round(ref_seconds, 3),
                      'word_check_seconds': round(check_seconds, 3), 'learner_acoustic_seconds': round(acoustic_seconds, 3),
                      'learner_total_seconds': round(check_seconds+acoustic_seconds, 3),
                      'reference_status': reference.alignment_status, 'learner_status': learner.alignment_status,
                      'tier': check.tier, 'evidence_sha256': sha256(evidence.encode()).hexdigest(), 'subprocesses': timings}
            outputs.append(result)
            print(json.dumps(result), flush=True)
        close_resident()
        print(json.dumps({'identical_evidence': outputs[0]['evidence_sha256'] == outputs[1]['evidence_sha256'],
                          'excludes': ['browser_upload', 'cloud_storage', 'queue_wait', 'UI_polling', 'worker_startup']}), flush=True)


if __name__ == '__main__':
    main()
