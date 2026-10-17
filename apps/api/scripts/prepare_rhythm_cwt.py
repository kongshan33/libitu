"""Prepare local public-seed features for the OFFLINE CWT experiment.

Run with the existing API acoustic environment. No application API/database,
uploads, worker claims, or runtime integration. Learner ASR/gates are reused.
"""
import argparse
from hashlib import sha256
import json
from pathlib import Path
from time import perf_counter

from app.config import get_settings
from app.services.acoustics import engine, mfa_runtime
from app.services.acoustics.practice_prosody import check_learner_words
from app.services.acoustics.reference_prosody import align_reference
from app.services.acoustics.word_check import analysis_scope


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--audio-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--sample-id", action="append", required=True)
    args = parser.parse_args()
    settings = get_settings()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    samples = json.loads(args.manifest.read_text())["samples"]
    started = perf_counter()
    mfa_runtime.check_startup(settings)
    startup = perf_counter()-started
    for sid in args.sample_id:
        source = next(s for s in samples if s["sample_id"] == sid)
        audio = args.audio_root / source["audio"]["path"]
        assert sha256(audio.read_bytes()).hexdigest() == source["audio"]["sha256"], "Audio hash mismatch"
        output = args.output_dir / f"{sid}.json"
        if output.exists():
            raise FileExistsError(f"Refusing to overwrite {output}; explicitly select a new directory")
        timings = {"shared_mfa_startup_sec": startup}
        text = source["transcript"]["text"]
        result = {"id": sid, "role": source["role"], "source": source["source"],
                  "audio_sha256": source["audio"]["sha256"], "gold_status": "none", "timings": timings}
        if source["role"] == "learner":
            tick = perf_counter()
            check = check_learner_words(audio, text, settings)
            timings["asr_word_check_sec"] = perf_counter()-tick
            result["word_check"] = check.model_dump(mode="json")
            if analysis_scope(check) != "all_layers":
                result["status"] = "skipped_by_existing_rhythm_gate"
                output.write_text(json.dumps(result, indent=2))
                print(json.dumps({"sample": sid, "status": result["status"], "tier": check.tier}), flush=True)
                continue
            text = " ".join(t.normalized for t in check.recognized_tokens)
        tick = perf_counter()
        frames, speech, pcm = engine.extract(audio, settings)
        measurements = engine.sentence_measurements(frames, speech, pcm, 0, len(pcm)/16000)
        timings["existing_feature_extraction_sec"] = perf_counter()-tick
        tick = perf_counter()
        if source["role"] == "reference":
            alignment, _ = align_reference(audio, text, 0, measurements, args.output_dir / f"mfa-{sid}", settings)
        elif not any(x in measurements.quality_issues for x in ("insufficient_speech", "low_energy", "clipping")):
            alignment = engine.align(audio, text, 0, args.output_dir / f"mfa-{sid}", settings)
        else:
            from app.schemas.reference import Alignment
            alignment = Alignment(status="unavailable", reason="insufficient_audio_quality")
        timings["existing_alignment_sec"] = perf_counter()-tick
        result.update({"alignment": alignment.model_dump(mode="json"),
                       "measurements": measurements.model_dump(mode="json"), "engine": engine.engine_identity(settings)})
        output.write_text(json.dumps(result, indent=2, allow_nan=False))
        print(json.dumps({"sample": sid, "status": alignment.status, "timings": timings}), flush=True)


if __name__ == "__main__":
    main()
