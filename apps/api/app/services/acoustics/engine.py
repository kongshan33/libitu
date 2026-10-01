"""Reference-only measurements. Imports are lazy so API does not load ML runtimes."""
from importlib.metadata import version
from pathlib import Path
import json
import os
import re
import shutil
import subprocess
import wave

from app.config import Settings
from app.schemas.reference import Alignment, Frame, Interval, Measurements, PIPELINE_VERSION
from app.services.acoustics.audio import AudioFailure, RATE, file_hash

SILERO_SHA256 = "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f"


def engine_identity(settings: Settings) -> dict:
    return {"pipeline": PIPELINE_VERSION, "f0": "praat-autocorrelation-75-500-10ms",
            "parselmouth": "0.4.7", "onnxruntime": "1.22.1", "numpy": "2.2.6",
            "vad": "silero-v5-512-context64-hysteresis-v1", "vad_sha256": SILERO_SHA256,
            "mfa": "3.3.9", "model_sha256": settings.acoustic_mfa_model_sha256,
            "dictionary_sha256": settings.acoustic_mfa_dictionary_sha256}


def tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)*", text.lower().replace("’", "'"))


def parse_alignment(data: dict, text: str, origin: float, duration: float) -> Alignment:
    tiers = data["tiers"]
    parsed = {}
    for kind in ("words", "phones"):
        # MFA's JSON exporter uses praatio tier entries, not arbitrary TextGrid text parsing.
        matches = [tier for name, tier in tiers.items() if name == kind or name.endswith(" - " + kind)]
        if len(matches) != 1:
            raise ValueError("Missing or ambiguous alignment tier")
        intervals = []
        last = 0.0
        for start, end, label in matches[0]["entries"]:
            if not label or label in ("sil", "sp", "spn", "<eps>"):
                if label == "spn":
                    raise ValueError("Unrecognized word")
                continue
            if not (0 <= start < end <= duration + 0.02) or start < last - 0.001:
                raise ValueError("Invalid interval bounds")
            last = end
            intervals.append(Interval(start_sec=origin + start, end_sec=origin + min(end, duration), label=label))
        parsed[kind] = intervals
    observed = [token for word in parsed["words"] for token in tokens(word.label or "")]
    if observed != tokens(text) or not parsed["phones"] or not observed:
        raise ValueError("Alignment token sequence mismatch")
    return Alignment(status="aligned", words=parsed["words"], phones=parsed["phones"])


def align(wav: Path, text: str, origin: float, directory: Path, settings: Settings) -> Alignment:
    model, dictionary = settings.acoustic_mfa_model, settings.acoustic_mfa_dictionary
    if not model or not dictionary:
        return Alignment(status="unavailable", reason="mfa_not_configured")
    for path, digest in ((model, settings.acoustic_mfa_model_sha256), (dictionary, settings.acoustic_mfa_dictionary_sha256)):
        if not digest or not Path(path).is_file() or file_hash(Path(path)) != digest:
            return Alignment(status="unavailable", reason="mfa_model_integrity")
    directory.mkdir(parents=True, exist_ok=True)
    transcript = directory / "sentence.lab"
    transcript.write_text(text, encoding="utf-8")
    output = directory / "alignment.json"
    binary = Path(settings.acoustic_mfa_binary).expanduser()
    # Reuse the provisioned decoder used for normalization. Conda's optional
    # ffmpeg build may pull in a different codec/runtime dependency tree.
    decoder = shutil.which("ffmpeg")
    decoder_bin = str(Path(decoder).resolve().parent) + os.pathsep if decoder else ""
    env = {**os.environ, "MFA_ROOT_DIR": str(directory / "runtime"),
           "PATH": decoder_bin + str(binary.resolve().parent) + os.pathsep + os.environ.get("PATH", "")}
    try:
        installed = subprocess.run([str(binary), "version"], capture_output=True, text=True, timeout=30, env=env)
        if installed.returncode or "3.3.9" not in installed.stdout:
            return Alignment(status="unavailable", reason="mfa_version_mismatch")
        subprocess.run([str(binary), "align_one", str(wav), str(transcript), dictionary, model, str(output),
                        "--output_format", "json", "--temporary_directory", str(directory / "work"),
                        "--num_jobs", "1", "--no_use_mp", "--clean", "--quiet"],
                       env=env, check=True, capture_output=True, timeout=180)
        with wave.open(str(wav)) as audio:
            duration = audio.getnframes() / RATE
        return parse_alignment(json.loads(output.read_text()), text, origin, duration)
    except FileNotFoundError:
        return Alignment(status="unavailable", reason="mfa_unavailable")
    except subprocess.TimeoutExpired:
        return Alignment(status="failed", reason="mfa_timeout")
    except (subprocess.CalledProcessError, ValueError, KeyError, TypeError, OSError):
        return Alignment(status="failed", reason="mfa_alignment_failed")


def extract(wav: Path, settings: Settings) -> tuple[list[Frame], list[Interval], object]:
    import numpy as np
    import parselmouth
    import onnxruntime as ort

    if any(version(name) != expected for name, expected in (
        ("numpy", "2.2.6"), ("praat-parselmouth", "0.4.7"), ("onnxruntime", "1.22.1")
    )):
        raise AudioFailure("acoustic_runtime_version_mismatch")
    model = Path(settings.acoustic_silero_path) if settings.acoustic_silero_path else (
        Path(__file__).resolve().parents[4] / "web/public/acoustic-assets/local-acoustics-v1/silero_vad_v5.onnx")
    if not model.is_file() or file_hash(model) != SILERO_SHA256:
        raise AudioFailure("vad_model_integrity")
    with wave.open(str(wav)) as audio:
        samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").astype(np.float32) / 32768
    if len(samples) < 640:
        raise AudioFailure("audio_too_short")
    sound = parselmouth.Sound(samples.astype(np.float64), sampling_frequency=RATE)
    pitch = sound.to_pitch_ac(time_step=0.01, pitch_floor=75, pitch_ceiling=500)
    frames = []
    for start in range(0, len(samples), 160):
        t = start / RATE
        window = samples[max(0, start - 320):min(len(samples), start + 320)]
        rms = float(np.sqrt(np.mean(window * window)))
        f0 = float(pitch.get_value_at_time(t))
        frames.append(Frame(time_sec=t, f0_hz=f0 if np.isfinite(f0) and f0 > 0 else None,
                            energy_dbfs=max(-120, 20 * float(np.log10(max(rms, 1e-6))))))
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"])
    state = np.zeros((2, 1, 128), dtype=np.float32)
    context = np.zeros((1, 64), dtype=np.float32)
    probabilities = []
    for start in range(0, len(samples), 512):
        frame = np.zeros((1, 512), dtype=np.float32)
        piece = samples[start:start + 512]
        frame[0, :len(piece)] = piece
        output, state = session.run(None, {"input": np.concatenate((context, frame), axis=1),
                                          "state": state, "sr": np.array(RATE, dtype=np.int64)})
        probability = float(output.flat[0])
        if not np.isfinite(probability) or not 0 <= probability <= 1:
            raise AudioFailure("invalid_vad_output")
        probabilities.append(probability)
        context = frame[:, -64:]
    # Hysteresis, >=250ms speech and >=200ms silence. Values are VAD parameters, not sound scores.
    speech = []
    active = None
    silence = None
    for index, probability in enumerate(probabilities):
        t = index * 512 / RATE
        if active is None and probability >= 0.5:
            active = t
        if active is not None:
            if probability >= 0.35:
                silence = None
            elif silence is None:
                silence = t
            elif t - silence >= 0.2:
                if silence - active >= 0.25:
                    speech.append(Interval(start_sec=active, end_sec=silence))
                active, silence = None, None
    end = len(samples) / RATE
    if active is not None and end - active >= 0.25:
        speech.append(Interval(start_sec=active, end_sec=end))
    return frames, speech, samples


def sentence_measurements(frames: list[Frame], speech: list[Interval], samples, start: float, end: float) -> Measurements:
    import numpy as np
    selected = [f for f in frames if start <= f.time_sec < end]
    audio = samples[round(start * RATE):round(end * RATE)]
    if not len(audio):
        raise AudioFailure("empty_sentence_audio")
    intervals = [Interval(start_sec=max(start, s.start_sec), end_sec=min(end, s.end_sec))
                 for s in speech if s.end_sec > start and s.start_sec < end]
    pauses = [Interval(start_sec=a.end_sec, end_sec=b.start_sec)
              for a, b in zip(intervals, intervals[1:]) if b.start_sec - a.end_sec >= 0.2]
    rms = max(-120, 20 * float(np.log10(max(float(np.sqrt(np.mean(audio * audio))), 1e-6))))
    clipping = float(np.mean(np.abs(audio) >= 0.999))
    valid = sum(f.f0_hz is not None for f in selected) / max(1, len(selected))
    issues = []
    if sum(s.end_sec - s.start_sec for s in intervals) < 0.15:
        issues.append("insufficient_speech")
    if rms < -50:
        issues.append("low_energy")
    if clipping > 0.01:
        issues.append("clipping")
    if valid < 0.1:
        issues.append("insufficient_pitch")
    return Measurements(duration_sec=end - start, rms_dbfs=rms, clipping_fraction=clipping,
                        f0_valid_fraction=valid, frames=selected, speech=intervals, pauses=pauses, quality_issues=issues)
