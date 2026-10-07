"use client";

import { Button } from "@/components/ui/button";

import { useMemo, type ReactNode } from "react";
import type { SentenceMeasurement } from "./api";
import type { AcousticFeatures } from "../acoustics/types";
import styles from "./ServerMeasurementPanel.module.css";

type Measurements = NonNullable<SentenceMeasurement["measurements"]>;
type LocalAnalysisStatus = { pending: boolean; error: string | null; retry(): void };
type PitchPoint = { position: number; semitones: number | null };
type PitchView = { points: PitchPoint[]; median: number; range: number };
const timingIssues = new Set(["insufficient_speech", "low_energy", "clipping"]);
const issueLabels: Record<string, string> = {
  silent: "The recording is too quiet or silent.", too_short: "The recording is too short.",
  insufficient_speech: "Too little speech was detected for timing measurements.",
  insufficient_pitch: "Too little reliable pitch was detected for a melody curve.",
  low_energy: "The reference is too quiet for reliable measurements.",
  clipping: "The reference audio is clipped. Measurements are withheld."
};

export function ServerMeasurementPanel({ layer, result, yours, yourAnalysis, concealed = false, rhythmText }: {
  layer: "sound" | "rhythm" | "melody"; result: SentenceMeasurement | null;
  yours: AcousticFeatures | null; yourAnalysis?: LocalAnalysisStatus; concealed?: boolean;
  rhythmText?: ReactNode;
}) {
  const measurements = result?.measurements ?? null;
  const referenceUsable = Boolean(measurements && !measurements.quality_issues.some(issue => timingIssues.has(issue)));
  const yoursUsable = yours?.quality.status === "usable";
  const referencePitch = useMemo(() => referencePitchView(measurements), [measurements]);
  const yourPitch = useMemo(() => localPitchView(yours), [yours]);
  const label = layer === "sound" ? "Sound" : layer === "rhythm" ? "Rhythm" : "Melody";
  return <section className="server-measurements" aria-label={`File reference ${label} measurements`}>
    <h3>{layer === "sound" ? "Sound · audio evidence" : layer === "rhythm" ? "Rhythm · stress & pauses" : "Melody · relative pitch"}</h3>
    {layer === "rhythm" ? rhythmText : null}
    <div className={styles.voices}>
      <section className={styles.voice} aria-label={`${label} reference audio evidence`}>
        <header className={styles.voiceHeading}><h4>Reference</h4><span>File analysis</span></header>
        {!measurements ? <p role="status">{result?.status === "failed" ? "Measurements unavailable for this sentence." : "Waiting for this sentence’s analysis."}</p> : <>
          <p role="status">{referenceUsable ? "Reference measurements ready." : "Reference measurements are limited."}</p>
          {layer === "sound" ? <>
            <p>{result?.alignment.status === "aligned" ? "Words and phonemes aligned to the supplied transcript. Spoken content has not been independently verified."
              : "Word and phoneme alignment unavailable. Rule suggestions remain separate from acoustic evidence."}</p>
            {referenceUsable && result?.alignment.status === "aligned" && !concealed ? <div className="server-word-durations">
              {result.alignment.words.map((word, index) => <span key={index}>{word.label} <small>{Math.round((word.end_sec - word.start_sec) * 1000)} ms</small></span>)}
            </div> : null}
            <p>Measured duration does not establish a sound phenomenon or pronunciation error.</p>
          </> : layer === "rhythm" ? <TimingValues duration={measurements.duration_sec}
            span={referenceUsable ? speechSpan(measurements) : null}
            speech={referenceUsable ? measurements.speech.reduce((sum, interval) => sum + interval.end_sec - interval.start_sec, 0) : null}
            pauses={referenceUsable ? measurements.pauses.length : null}
            pauseDuration={referenceUsable ? measurements.pauses.reduce((sum, interval) => sum + interval.end_sec - interval.start_sec, 0) : null} />
            : <PitchValues pitch={referencePitch} />}
          <QualityNotes issues={measurements.quality_issues} />
        </>}
      </section>
      <section className={`${styles.voice} ${styles.yourVoice}`} aria-label={`${label} current recording audio evidence`}>
        <header className={styles.voiceHeading}><h4>Your recording</h4><span>Current take · on this device</span></header>
        <p role="status">{yourAnalysis?.pending ? "Analyzing your recording on this device…" : yourAnalysis?.error ? "Your recording could not be analyzed."
          : yours ? yoursUsable ? "Local analysis ready." : "Your recording has limited evidence."
            : "Record a take to see your audio measurements here."}</p>
        {yourAnalysis?.error ? <p role="alert">{yourAnalysis.error} <Button variant="secondary" size="inherit" className={styles.retry} type="button" onClick={yourAnalysis.retry}>Retry local analysis</Button></p> : null}
        {yours ? <>
          {layer === "melody" ? <PitchValues pitch={yourPitch} /> : <TimingValues recording duration={yours.durationMs / 1000}
            span={yoursUsable && yours.speechSpanMs !== null ? yours.speechSpanMs / 1000 : null}
            speech={yoursUsable ? yours.speechDurationMs / 1000 : null}
            pauses={yoursUsable ? yours.pauseCount : null}
            pauseDuration={yoursUsable ? yours.internalPauseDurationMs / 1000 : null} />}
          <QualityNotes issues={yours.quality.issues} />
        </> : null}
        {layer === "sound" ? <p>Your local analysis measures speech timing, pauses and pitch. It does not align your words or identify phonemes. Word-by-word Sound checks appear after an eligible server analysis.</p> : null}
      </section>
    </div>
    {layer === "melody" ? <RelativePitchChart reference={referencePitch} yours={yourPitch} /> : null}
    <p className={styles.note}>{layer === "sound" ? "Dictionary suggestions describe possible readings. Neither timing nor pitch confirms that you used a particular sound."
      : "Reference and current recording use different analysis versions. These measurements describe the audio; no pronunciation score is inferred."}</p>
  </section>;
}

function TimingValues({ duration, span, speech, pauses, pauseDuration, recording = false }: {
  duration: number; span: number | null; speech: number | null; pauses: number | null; pauseDuration: number | null; recording?: boolean;
}) {
  return <dl className={styles.values}>
    <div><dt>{recording ? "Recording duration" : "Sentence duration"}</dt><dd>{seconds(duration)}</dd></div>
    <div><dt>Speaking span</dt><dd>{seconds(span)}</dd></div>
    <div><dt>Speech detected</dt><dd>{seconds(speech)}</dd></div>
    <div><dt>Internal pauses ≥200 ms</dt><dd>{pauses ?? "—"}</dd></div>
    <div><dt>Internal pause time</dt><dd>{seconds(pauseDuration)}</dd></div>
  </dl>;
}

function PitchValues({ pitch }: { pitch: PitchView | null }) {
  return <dl className={styles.values}>
    <div><dt>Median pitch</dt><dd>{pitch ? `${Math.round(pitch.median)} Hz` : "—"}</dd></div>
    <div><dt>Pitch range</dt><dd>{pitch ? `${pitch.range.toFixed(1)} st` : "—"}</dd></div>
  </dl>;
}

function QualityNotes({ issues }: { issues: string[] }) {
  return issues.length ? <p>{issues.map(issue => issueLabels[issue] ?? issue.replaceAll("_", " ")).join(" ")}</p> : null;
}

function seconds(value: number | null) { return value === null ? "—" : `${value.toFixed(2)} s`; }
function speechSpan(measurements: Measurements) {
  const first = measurements.speech[0], last = measurements.speech.at(-1);
  return first && last ? Math.max(0, last.end_sec - first.start_sec) : null;
}

function quantile(sorted: number[], fraction: number) {
  const index = (sorted.length - 1) * fraction, low = Math.floor(index), weight = index - low;
  return sorted[low] * (1 - weight) + sorted[Math.ceil(index)] * weight;
}

function referencePitchView(measurements: Measurements | null): PitchView | null {
  if (!measurements || measurements.quality_issues.some(issue => timingIssues.has(issue) || issue === "insufficient_pitch")) return null;
  const span = speechSpan(measurements), start = measurements.speech[0]?.start_sec;
  if (!span || start === undefined) return null;
  const pitches = measurements.frames.flatMap(frame => frame.f0_hz !== null && Number.isFinite(frame.f0_hz) && frame.f0_hz > 0 ? [frame.f0_hz] : []).sort((a, b) => a - b);
  if (!pitches.length) return null;
  const median = quantile(pitches, 0.5);
  return { median, range: 12 * Math.log2(quantile(pitches, 0.9) / quantile(pitches, 0.1)),
    points: measurements.frames.map(frame => ({ position: (frame.time_sec - start) / span,
      semitones: frame.f0_hz !== null && Number.isFinite(frame.f0_hz) && frame.f0_hz > 0 ? 12 * Math.log2(frame.f0_hz / median) : null })) };
}

function localPitchView(features: AcousticFeatures | null): PitchView | null {
  if (features?.quality.status !== "usable" || features.quality.issues.includes("insufficient_pitch")
    || !features.speechSpanMs || features.speechStartMs === null || features.pitchMedianHz === null || features.pitchRangeSemitones === null) return null;
  const start = features.speechStartMs, span = features.speechSpanMs;
  return { median: features.pitchMedianHz, range: features.pitchRangeSemitones,
    points: features.pitchCurve.map(point => ({ position: (point.timeMs - start) / span, semitones: point.semitones })) };
}

function RelativePitchChart({ reference, yours }: { reference: PitchView | null; yours: PitchView | null }) {
  const extent = Math.max(6, ...[reference, yours].flatMap(voice => voice?.points.flatMap(point =>
    point.semitones === null || !Number.isFinite(point.semitones) || point.position < 0 || point.position > 1 ? [] : [Math.ceil(Math.abs(point.semitones))]) ?? []));
  function trace(voice: PitchView) {
    let connected = false;
    return voice.points.map(point => {
      if (point.semitones === null || !Number.isFinite(point.semitones) || point.position < 0 || point.position > 1) { connected = false; return ""; }
      const x = 44 + point.position * 542, y = 86 - point.semitones / extent * 62;
      const command = `${connected ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      connected = true;
      return command;
    }).join(" ");
  }
  return <figure className={styles.pitchChart}>
    <figcaption><strong>Relative pitch</strong><span className={styles.legend}><span>Reference</span><span>Your recording</span></span></figcaption>
    <svg viewBox="0 0 600 178" role="img" aria-label="Reference and current recording relative pitch; normalized speech time, not aligned by word; gaps indicate missing pitch">
      {[-extent, 0, extent].map(value => <g key={value} className={styles.axis}>
        <line x1="44" x2="586" y1={86 - value / extent * 62} y2={86 - value / extent * 62} />
        <text x="36" y={90 - value / extent * 62} textAnchor="end">{value > 0 ? "+" : ""}{value} st</text>
      </g>)}
      {reference ? <path className={styles.referenceTrace} d={trace(reference)} /> : null}
      {yours ? <path className={styles.yourTrace} d={trace(yours)} /> : null}
      <g className={styles.axis}><text x="44" y="172">Start of speech</text><text x="586" y="172" textAnchor="end">End of speech</text></g>
    </svg>
    {!reference || !yours ? <p>{!reference && !yours ? "Reliable pitch is needed before either curve can be drawn." : !yours ? "Your curve appears when this recording has enough reliable pitch." : "Reference pitch is unavailable; your recording is shown independently."}</p> : null}
    <p>Each voice is centered on its own median pitch and spans its own speech duration. The curves are not aligned by word. Gaps stay empty; pitch range covers the middle 80% of reliable values.</p>
  </figure>;
}
