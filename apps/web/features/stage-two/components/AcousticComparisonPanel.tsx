"use client";

import { memo, useMemo, type ReactNode } from "react";
import { Activity, Waves } from "lucide-react";
import { compareAcoustics } from "../acoustics/comparison";
import type { AcousticFeatures } from "../acoustics/types";

export type AudioAnalysisView = {
  features: AcousticFeatures | null;
  error: string | null;
  pending: boolean;
  retry(): void;
  canRetry?: boolean;
};

type Props = {
  layer: "rhythm" | "melody";
  reference: AudioAnalysisView;
  yours: AudioAnalysisView;
  rhythmText?: ReactNode;
};

export const AcousticComparisonPanel = memo(function AcousticComparisonPanel({ layer, reference, yours, rhythmText }: Props) {
  const isRhythm = layer === "rhythm";
  const comparison = useMemo(() => reference.features && yours.features
    ? compareAcoustics(reference.features, yours.features) : null, [reference.features, yours.features]);
  const rangeDifference = pitchAvailable(reference.features) && pitchAvailable(yours.features)
    ? comparison?.pitchRangeDifferenceSemitones ?? null : null;
  return (
    <section className={`stage-two-acoustics stage-two-acoustics-${layer}`} aria-label={isRhythm ? "Rhythm comparison" : "Melody comparison"}>
      <div className="stage-two-recording-heading">
        <h2>{isRhythm ? <Activity aria-hidden="true" /> : <Waves aria-hidden="true" />}{isRhythm ? "Rhythm · timing & pauses" : "Melody · intonation"}</h2>
        <span>Analyzed on this device</span>
      </div>
      <div className="stage-two-layer-workspace">
        <div className="stage-two-layer-canvas">
          <p className="stage-two-acoustics-intro">{isRhythm
            ? "Follow the words, feel the syllables, and see where the reference pauses."
            : "Compare the rise and fall of each voice, from the start to the end of this sentence."}</p>
          {isRhythm ? rhythmText : null}
          <div className="stage-two-analysis-status" aria-live="polite">
            <AnalysisStatus layer={layer} label="Reference" result={reference} empty="Listen to this sentence with practice audio enabled to prepare its reference." />
            <AnalysisStatus layer={layer} label="Your voice" result={yours} empty={isRhythm ? "Record a take to see your timing and pauses." : "Record a take to see your pitch curve."} />
          </div>
          {!isRhythm ? <PitchChart reference={reference.features} yours={yours.features} /> : null}
          <div className="stage-two-acoustic-table-wrap">
            <table className="stage-two-acoustic-table">
              <caption>Measurements for this sentence</caption>
              <thead><tr><th scope="col">Measurement</th><th scope="col">Reference</th><th scope="col">Your voice</th></tr></thead>
              <tbody>
                {isRhythm ? <>
                  <tr><th scope="row">Speaking span</th><td>{span(reference.features)}</td><td>{span(yours.features)}</td></tr>
                  <tr><th scope="row">Internal pauses</th><td>{pauses(reference.features)}</td><td>{pauses(yours.features)}</td></tr>
                </> : <tr><th scope="row">Pitch range</th><td>{pitchRange(reference.features)}</td><td>{pitchRange(yours.features)}</td></tr>}
              </tbody>
            </table>
          </div>
          {isRhythm && comparison?.status === "available" && comparison.durationRatio !== null ? (
            <p className="stage-two-acoustic-observation">Your speaking span is {comparison.durationRatio.toFixed(2)}× the reference.
              {comparison.pauseCountDifference === 0 ? " Both have the same number of detected internal pauses."
                : comparison.pauseCountDifference !== null ? ` You have ${Math.abs(comparison.pauseCountDifference)} ${comparison.pauseCountDifference > 0 ? "more" : "fewer"} detected internal pause${Math.abs(comparison.pauseCountDifference) === 1 ? "" : "s"}.` : ""}</p>
          ) : null}
          {!isRhythm && rangeDifference !== null ? <p className="stage-two-acoustic-observation">
            {Math.abs(rangeDifference) < 0.05 ? "Both voices have the same measured pitch range."
              : `Your pitch range is ${Math.abs(rangeDifference).toFixed(1)} st ${rangeDifference > 0 ? "wider" : "narrower"} than the reference.`}
          </p> : null}
          <p className="stage-two-recording-note">{isRhythm
            ? "Speaking span includes internal pauses and excludes silence at the edges."
            : "Each voice is centered on its own median pitch. Position runs from first to last detected speech; matching positions do not imply matching words. Pitch range measures the middle 80% of reliable pitch values."}</p>
        </div>
        <aside className="stage-two-layer-focus" aria-label={isRhythm ? "Rhythm layer focus" : "Melody layer focus"}>
          <div className="stage-two-layer-overview">
            <span className="stage-two-layer-overview-label">LAYER FOCUS · {isRhythm ? "PACE & PAUSES" : "RISE & FALL"}</span>
            <strong>{isRhythm ? "Find the pulse of the sentence" : "Follow the shape of the voice"}</strong>
            <p>{isRhythm
              ? "Listen for the flow of speech and the spaces between phrases. Compare your speaking time and pauses with the reference."
              : "Listen for where the voice rises and falls. Compare the shape and range of each voice after centering it on its own usual pitch."}</p>
          </div>
          <div className="stage-two-layer-unassessed">
            <strong>{isRhythm ? "Word stress ≠ sentence emphasis" : "Nuclear stress · not evaluated"}</strong>
            <p>{isRhythm
              ? "The dots show dictionary syllable stress. Listen for which words the speaker actually emphasizes; this is not yet assessed. Pause markers come from audio, with approximate caption positions."
              : "Listen for the word that carries the main pitch movement. These curves do not yet identify that word or attach pitch changes to individual words."}</p>
          </div>
          <p className="stage-two-recording-note">Music, overlapping speakers and an incomplete sentence can affect these measurements. They do not grade pronunciation.</p>
        </aside>
      </div>
    </section>
  );
});

function AnalysisStatus({ layer, label, result, empty }: {
  layer: Props["layer"]; label: string; result: AudioAnalysisView; empty: string;
}) {
  const issues: Record<string, string> = {
    silent: "The audio is too quiet or silent.", too_short: "The clip is too short.",
    insufficient_speech: "Too little speech was detected to compare timing.",
    insufficient_pitch: "Too little reliable pitch was detected to compare melody."
  };
  const relevantIssues = result.features?.quality.issues.filter((issue) => layer === "melody" || issue !== "insufficient_pitch") ?? [];
  return <div>
    <strong>{label}: </strong>
    {result.pending ? "Analyzing locally… The first run loads the speech model." : result.error
      ? <><span role="alert">{result.error}</span> {result.canRetry !== false
        ? <button type="button" onClick={result.retry}>Retry analysis</button>
        : <span>Play the sentence again to prepare its reference.</span>}</>
      : result.features ? relevantIssues.length
        ? relevantIssues.map((issue) => issues[issue] ?? issue).join(" ") : "Analysis ready."
        : empty}
  </div>;
}

function span(features: AcousticFeatures | null) {
  return features?.speechSpanMs != null && features.quality.status === "usable" ? `${(features.speechSpanMs / 1000).toFixed(2)} s` : "—";
}
function pauses(features: AcousticFeatures | null) {
  return features?.quality.status === "usable"
    ? `${features.pauseCount} · ${(features.internalPauseDurationMs / 1000).toFixed(2)} s` : "—";
}
function pitchRange(features: AcousticFeatures | null) {
  return pitchAvailable(features) && features.pitchRangeSemitones != null
    ? `${features.pitchRangeSemitones.toFixed(1)} st` : "—";
}

function pitchAvailable(features: AcousticFeatures | null): features is AcousticFeatures {
  return features?.quality.status === "usable" && !features.quality.issues.includes("insufficient_pitch");
}

function normalizedTime(features: AcousticFeatures, timeMs: number) {
  return (timeMs - (features.speechStartMs ?? 0)) / Math.max(1, features.speechSpanMs ?? features.durationMs);
}

function PitchChart({ reference, yours }: { reference: AcousticFeatures | null; yours: AcousticFeatures | null }) {
  const voices = [reference, yours];
  const valid = voices.map((features) => pitchAvailable(features) ? features : null);
  const pitches = valid.flatMap((features) => features?.pitchCurve.flatMap((point) => point.semitones === null ? [] : [Math.abs(point.semitones)]) ?? []);
  const extent = Math.max(6, Math.ceil(Math.max(0, ...pitches)));
  const width = 600, left = 38, right = 588, top = 18, bottom = 142;
  function curve(features: AcousticFeatures) {
    let penDown = false;
    return features.pitchCurve.map((point) => {
      const position = normalizedTime(features, point.timeMs);
      if (point.semitones === null || position < 0 || position > 1) { penDown = false; return ""; }
      const x = left + position * (right - left);
      const y = (top + bottom) / 2 - point.semitones / extent * (bottom - top) / 2;
      const command = `${penDown ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      penDown = true;
      return command;
    }).join(" ");
  }
  return <figure className="stage-two-acoustic-chart">
    <figcaption><strong>Melody · relative pitch</strong><Legend /></figcaption>
    <svg viewBox={`0 0 ${width} 168`} role="img" aria-label={valid.some(Boolean)
      ? "Reference and your voice pitch curves, in semitones relative to each speaker's median. Gaps indicate unreliable or unvoiced audio."
      : "Empty pitch chart. Reliable voiced speech is needed for a pitch curve."}>
      {[-extent, 0, extent].map((tick) => {
        const y = (top + bottom) / 2 - tick / extent * (bottom - top) / 2;
        return <g key={tick}><line x1={left} x2={right} y1={y} y2={y} className="stage-two-chart-grid" /><text x="30" y={y + 4} textAnchor="end">{tick > 0 ? "+" : ""}{tick}</text></g>;
      })}
      {valid.map((features, index) => features ? <path key={index} d={curve(features)} className={index ? "stage-two-chart-yours" : "stage-two-chart-reference"} /> : null)}
      <text x={left} y="161">Start</text><text x={right} y="161" textAnchor="end">End of speech</text>
    </svg>
    {!valid.some(Boolean) ? <p className="stage-two-chart-empty">Your pitch curves will appear here after analysis. Reliable voiced speech is needed for a pitch curve.</p> : null}
    <p className="stage-two-recording-note">Vertical scale: semitones (st). Gaps show unvoiced or unreliable pitch.</p>
  </figure>;
}

function Legend() {
  return <span className="stage-two-chart-legend"><span>Reference</span><span>Your voice</span></span>;
}
