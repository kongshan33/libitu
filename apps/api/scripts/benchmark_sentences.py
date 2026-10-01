"""Offline formatter benchmark; never invokes a caption or language-model provider.

Run from apps/api:
    uv run python scripts/benchmark_sentences.py --transcript /path/to/captions.txt
    uv run python scripts/benchmark_sentences.py --synthetic-words 9000 --runs 3

Each mode gets a fresh Python process. Cold-start measurements include module and
model loading; warm measurements reuse both model instances. Output contains only
aggregate metadata, never caption text. Synthetic input is for timing, not quality
evaluation. --transcript expects the formatter's timestamped/plain-text format.
"""

from __future__ import annotations

import argparse
from contextlib import redirect_stdout
from dataclasses import asdict
import io
import json
import os
from pathlib import Path
import platform
import resource
import statistics
import subprocess
import sys
from time import perf_counter


API_ROOT = Path(__file__).resolve().parents[1]


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--transcript", type=Path)
    source.add_argument("--synthetic-words", type=int)
    source.add_argument("--stdin", action="store_true", help="Read caption text from stdin without saving it.")
    parser.add_argument("--runs", type=int, default=3, help="Warm repetitions per mode.")
    parser.add_argument("--worker", choices=("punctuation_only", "with_syntax"), help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be positive")
    if args.synthetic_words is not None and args.synthetic_words < 1:
        parser.error("--synthetic-words must be positive")
    return args


def _transcript(args: argparse.Namespace) -> str:
    if args.stdin:
        return sys.stdin.read()
    if args.transcript:
        return args.transcript.read_text(encoding="utf-8")
    # Intentionally unpunctuated, so the full sherpa path is exercised when its
    # deployment assets are installed. Repeated constructed prose is not a video
    # sample and cannot establish segmentation quality or production latency.
    passage = (
        "Although the team had reviewed the proposal several times we still needed "
        "to understand how the decision would affect our customers over the next year "
        "the first experiment gave us useful information about the problem "
        "we decided to keep the existing service running because people depended on it "
        "when the results became available we discussed them with the whole team "
        "that was the point at which we agreed to change our original plan "
        "we listened carefully and made a decision together"
    ).split()
    words = (passage * (args.synthetic_words // len(passage) + 1))[: args.synthetic_words]
    rows: list[str] = []
    for start in range(0, len(words), 12):
        seconds = start // 3
        rows.append(f"{seconds // 3600:02d}:{seconds // 60 % 60:02d}:{seconds % 60:02d}\t{' '.join(words[start:start + 12])}")
    return "\n".join(rows)


def _peak_rss_mib() -> float:
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(rss / (1024 * 1024 if sys.platform == "darwin" else 1024), 2)


def _current_rss_mib() -> float | None:
    try:
        # ps reports current RSS in KiB on macOS and Linux. Peak RSS is reported
        # separately; subtracting two high-water marks does not measure residency.
        rss = subprocess.check_output(
            ["ps", "-o", "rss=", "-p", str(os.getpid())], text=True
        )
        return round(int(rss.strip()) / 1024, 2)
    except (OSError, ValueError, subprocess.CalledProcessError):
        return None


def _ms(start: float) -> float:
    return round((perf_counter() - start) * 1000, 2)


def _worker(args: argparse.Namespace) -> dict[str, object]:
    transcript = _transcript(args)
    sys.path.insert(0, str(API_ROOT))
    cold_start = perf_counter()
    rss_before = _current_rss_mib()
    with redirect_stdout(io.StringIO()):
        from app.integrations.local_punctuation import get_punctuation_engine
        from app.integrations.sentence_syntax import get_sentence_syntax
        from app.services.transcript_formatter import (
            format_transcript, parse_transcript, filter_filler_tokens, WORD_TOKEN,
            _has_reliable_source_punctuation,
        )
        from app.services.sentence_formatter import _TERMINAL

        imports_ms = _ms(cold_start)
        source_lines = filter_filler_tokens(parse_transcript(transcript, preserve_rows=True))
        reliable = bool(source_lines) and (
            _has_reliable_source_punctuation(source_lines)
            or all(_TERMINAL.search(line.text) for line in source_lines)
        )
        load_start = perf_counter()
        punctuation = None if reliable else get_punctuation_engine("en")
        punctuation_load_ms = _ms(load_start)
        load_start = perf_counter()
        syntax = get_sentence_syntax("en") if args.worker == "with_syntax" and not reliable else None
        syntax_load_ms = _ms(load_start)
        model_ready_ms = _ms(cold_start)
        rss_loaded = _current_rss_mib()
        observations: list[dict[str, object]] = []
        source_words = WORD_TOKEN.findall(" ".join(line.text for line in source_lines))
        for iteration in range(args.runs + 1):
            start = perf_counter()
            first_preview_ms: float | None = None
            first_preview_from_cold_ms: float | None = None
            first_preview_sentences = 0
            previews = 0
            prefix_stable = True
            previous: list[dict[str, object]] = []
            syntax_seconds = 0.0
            syntax_decisions = 0
            syntax_merges = 0

            class TimedSyntax:
                def should_merge(self, left: str, right: str, source: str) -> bool:
                    nonlocal syntax_seconds, syntax_decisions, syntax_merges
                    decision_start = perf_counter()
                    try:
                        merged = syntax.should_merge(left, right, source)
                        syntax_decisions += 1
                        syntax_merges += int(merged)
                        return merged
                    finally:
                        syntax_seconds += perf_counter() - decision_start

            def on_progress(lines: list[object]) -> None:
                nonlocal first_preview_ms, first_preview_from_cold_ms
                nonlocal first_preview_sentences, previews, prefix_stable, previous
                if not lines:
                    return
                if first_preview_ms is None:
                    first_preview_ms = _ms(start)
                    first_preview_from_cold_ms = _ms(cold_start) if iteration == 0 else None
                    first_preview_sentences = len(lines)
                snapshot = [asdict(line) for line in lines]
                prefix_stable = prefix_stable and snapshot[:len(previous)] == previous
                previous = snapshot
                previews += 1

            lines = format_transcript(
                transcript, language="en", engine=punctuation,
                syntax_engine=TimedSyntax() if syntax is not None else None,
                on_progress=on_progress,
            )
            total_ms = _ms(start)
            prefix_stable = prefix_stable and [asdict(line) for line in lines[:len(previous)]] == previous
            output_words = WORD_TOKEN.findall(" ".join(line.text for line in lines))
            observations.append({
                "run": "cold" if iteration == 0 else f"warm_{iteration}",
                "format_ms": total_ms,
                "first_preview_ms": first_preview_ms,
                "first_preview_including_cold_load_ms": first_preview_from_cold_ms,
                "first_preview_sentences": first_preview_sentences,
                "preview_count": previews,
                "preview_prefix_stable": prefix_stable,
                "output_sentences": len(lines),
                "source_words_preserved": [word.casefold() for word in source_words] == [word.casefold() for word in output_words],
                "source_casing_preserved": source_words == output_words,
                "source_word_count": len(source_words),
                "syntax_decision_ms": round(syntax_seconds * 1000, 2),
                "syntax_decision_count": syntax_decisions,
                "syntax_merge_count": syntax_merges,
                "rss_mib": _current_rss_mib(),
                "peak_rss_mib": _peak_rss_mib(),
            })
    from importlib.metadata import version

    warm = observations[1:]
    warm_previews = [row["first_preview_ms"] for row in warm if row["first_preview_ms"] is not None]
    return {
        "mode": args.worker,
        "spacy_version": version("spacy"),
        "model_version": version("en-core-web-sm"),
        "reliable_source_punctuation": reliable,
        "punctuation_engine_loaded": punctuation is not None,
        "syntax_available": syntax is not None,
        "imports_ms": imports_ms,
        "punctuation_load_ms": punctuation_load_ms,
        "syntax_load_ms": syntax_load_ms,
        "imports_and_models_ms": model_ready_ms,
        "rss_before_mib": rss_before,
        "rss_models_loaded_mib": rss_loaded,
        "warm_format_median_ms": statistics.median(row["format_ms"] for row in warm),
        "warm_first_preview_median_ms": statistics.median(warm_previews) if warm_previews else None,
        "runs": observations,
    }


def main() -> None:
    args = _arguments()
    if args.worker:
        print(json.dumps(_worker(args), separators=(",", ":")))
        return
    transcript = _transcript(args)
    modes: list[dict[str, object]] = []
    for mode in ("punctuation_only", "with_syntax"):
        output = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--stdin",
             "--runs", str(args.runs), "--worker", mode],
            check=True, capture_output=True, text=True, input=transcript,
        )
        modes.append(json.loads(output.stdout))
    print(json.dumps({
        "sample_kind": "user_provided_text" if args.transcript or args.stdin else "constructed_repeated_prose",
        "characters": len(transcript),
        "input_rows": len(transcript.splitlines()),
        "python": platform.python_version(),
        "platform": platform.system(),
        "architecture": platform.machine(),
        "notes": [
            "No paid model or caption provider is called.",
            "Model cold loading is timed separately and included in the cold first preview.",
            "RSS includes the full process; it is not spaCy-only memory.",
            "Timing measurements do not evaluate semantic boundary quality.",
            "Total formatting includes the cost of checking preview metadata stability.",
        ],
        "results": modes,
    }, indent=2))


if __name__ == "__main__":
    main()
