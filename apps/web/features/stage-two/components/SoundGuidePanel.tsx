"use client";

import { Button } from "@/components/ui/button";

import { memo, useState } from "react";
import { AudioLines, Eye, EyeOff } from "lucide-react";
import type { SoundAnnotation, SoundCandidate, SoundKind } from "@libitu/types/stage-two";
import type { AudioAnalysisView } from "./AcousticComparisonPanel";
import type { useSoundGuide } from "../sound/use-sound-guide";
import { soundObservation, type SoundObservation } from "../sound/evidence";

const labels: Record<SoundKind, string> = {
  linking: "Linking", weak_form: "Weak form", flap: "Flap", assimilation: "Assimilation", elision: "Elision"
};
const kinds = Object.keys(labels) as SoundKind[];
type Props = {
  sentenceId: string | null;
  guide: ReturnType<typeof useSoundGuide>;
  reference: AudioAnalysisView;
  yours: AudioAnalysisView;
  recordingAvailable: boolean;
  textHidden: boolean;
  onTextHiddenChange(hidden: boolean): void;
  showRecordingSummary?: boolean;
};

export const SoundGuidePanel = memo(function SoundGuidePanel({ guide, sentenceId, reference, yours, recordingAvailable,
  textHidden, onTextHiddenChange, showRecordingSummary = false }: Props) {
  const originalEvidence = soundObservation({ ...reference, available: Boolean(reference.features) });
  const yourEvidence = soundObservation({ ...yours, available: recordingAvailable });
  return <section className="stage-two-sound" aria-label="Sound guide">
    <div className="stage-two-recording-heading">
      <h2><AudioLines aria-hidden="true" /> Sound · connected speech</h2>
      <span>General American · possible readings</span>
    </div>
    {showRecordingSummary ? <div className="stage-two-analysis-status" aria-label="Sound recording measurements">
      <SoundRecordingSummary label="Reference" analysis={reference} />
      <SoundRecordingSummary label="Your recording" analysis={yours} />
    </div> : null}
    {!sentenceId ? <p className="stage-two-recording-note">Select a sentence to see its sound guide.</p> : null}
    {guide.pending ? <p role="status">Preparing this sentence’s sound guide…</p> : null}
    {guide.error ? <div className="stage-two-sound-error"><p role="alert">{guide.error}</p>
      <Button variant="secondary" size="inherit" type="button" onClick={guide.retry}>Retry sound guide</Button></div> : null}
    {guide.data ? <SoundGuide key={`${guide.data.sentence_id}:${guide.data.sentence_text}`} data={guide.data}
      reference={originalEvidence} yours={yourEvidence} textHidden={textHidden} onTextHiddenChange={onTextHiddenChange} /> : null}
  </section>;
});

function SoundRecordingSummary({ label, analysis }: { label: string; analysis: AudioAnalysisView }) {
  const features = analysis.features;
  return <section aria-label={`${label} local Sound evidence`}>
    <strong>{label}</strong>
    <p>{analysis.pending ? "Analyzing timing and pitch…" : analysis.error ? "Audio analysis could not finish."
      : features?.quality.status === "usable" ? `Analysis ready · ${(features.speechDurationMs / 1000).toFixed(2)} s of speech · ${features.pauseCount} internal pauses.`
        : features ? "Too little usable speech for measurements." : label === "Reference" ? "Listen with practice audio enabled to prepare reference measurements." : "Record a take to see your measurements."}</p>
    {analysis.error ? <p role="alert">{analysis.error}{analysis.canRetry !== false ? <Button variant="secondary" size="inherit" type="button" onClick={analysis.retry}>Retry audio analysis</Button> : null}</p> : null}
    <small>Local timing and pitch do not identify individual sounds. Aligned word measurements appear after server analysis.</small>
  </section>;
}

function SoundGuide({ data, reference, yours, textHidden, onTextHiddenChange }: {
  data: SoundAnnotation; reference: SoundObservation; yours: SoundObservation;
  textHidden: boolean; onTextHiddenChange(hidden: boolean): void;
}) {
  const [kind, setKind] = useState<SoundKind | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const candidates = kind === "all" ? data.candidates : data.candidates.filter((candidate) => candidate.kind === kind);
  const selected = candidates.find((candidate) => candidate.id === selectedId) ?? candidates[0] ?? null;
  const unknown = data.tokens.filter((token) => token.status === "unknown");
  const ambiguous = data.tokens.filter((token) => token.status === "ambiguous");
  return <div className="stage-two-layer-workspace">
    <div className="stage-two-layer-canvas">
    <p className="stage-two-acoustics-intro">Explore sounds that may change in connected speech. These are suggestions from the words and dictionary pronunciations; they do not confirm what either speaker said.</p>
    <div className="stage-two-sound-filters" role="group" aria-label="Sound phenomenon filters">
      <button type="button" aria-pressed={kind === "all"} onClick={() => setKind("all")}>All <span>{data.candidates.length}</span></button>
      {kinds.map((value) => <button key={value} type="button" data-phenomenon={value} aria-pressed={kind === value} onClick={() => setKind(value)}>
        {labels[value]} <span>{data.candidates.filter((candidate) => candidate.kind === value).length}</span>
      </button>)}
    </div>
    <div className="stage-two-sound-reveal">
      <span><strong>{textHidden ? "Listen & recall" : "Explore the sentence"}</strong>
        <small>{textHidden ? "Click a covered word when you need a hint." : "Select a word to explore its possible sound changes."}</small></span>
      <div><Button variant="secondary" size="inherit" type="button" onClick={() => { setRevealed(new Set()); onTextHiddenChange(true); }}><EyeOff aria-hidden="true" /> Hide text</Button>
        <Button variant="secondary" size="inherit" type="button" onClick={() => onTextHiddenChange(false)}><Eye aria-hidden="true" /> Reveal all</Button></div>
      {textHidden ? <small role="status">{revealed.size} of {data.tokens.length} words revealed</small> : null}
    </div>
    <div className="stage-two-wordflow-heading"><strong>Practice text</strong><span>Dictionary IPA · possible readings</span></div>
    <div className="stage-two-wordflow" role="group" aria-label="Sentence word cards">
      {data.tokens.map((token) => {
        const covered = textHidden && !revealed.has(token.index);
        const suggestions = candidates.filter((candidate) => token.index >= candidate.token_start && token.index < candidate.token_end);
        const tokenKinds = [...new Set(suggestions.map((candidate) => candidate.kind))];
        const highlighted = !textHidden && selected && token.index >= selected.token_start && token.index < selected.token_end;
        return <button key={token.index} type="button" className={`stage-two-wordcard${covered ? " is-covered" : ""}${kind !== "all" && !suggestions.length ? " is-muted" : ""}`}
          aria-label={covered ? `Reveal word ${token.index + 1}` : `Word ${token.index + 1}: ${token.text}`}
          aria-pressed={covered ? undefined : Boolean(highlighted)} onClick={() => {
            if (covered) setRevealed((current) => new Set(current).add(token.index));
            else if (suggestions.length) setSelectedId(suggestions.find((candidate) => candidate.id === selected?.id)?.id ?? suggestions[0].id);
          }}>
          <span className="stage-two-word-ipa">{covered ? "\u00a0" : token.ipa.length ? token.ipa.join(" · ") : "IPA unavailable"}</span>
          <span className="stage-two-word-text">{covered ? <span className="stage-two-word-cover" aria-hidden="true">•••</span> : token.text}</span>
          <span className="stage-two-word-badges">{covered ? null : tokenKinds.map((value) => <span key={value} data-phenomenon={value}>{labels[value]}</span>)}</span>
        </button>;
      })}
    </div>
    <p className="stage-two-sound-sentence" aria-label="Sound guide sentence" hidden={textHidden}><HighlightedSentence data={data} candidate={selected} /></p>
    {candidates.length ? <div hidden={textHidden}>
      <div className="stage-two-sound-candidates" role="group" aria-label="Possible sound changes">
        {candidates.map((candidate) => <button key={candidate.id} type="button" aria-pressed={candidate.id === selected?.id}
          data-phenomenon={candidate.kind} onClick={() => setSelectedId(candidate.id)} aria-label={`${labels[candidate.kind]}: ${candidate.source_text}`}>
          <span>{labels[candidate.kind]}</span> {candidate.source_text}
        </button>)}
      </div>
    </div> : <p className="stage-two-recording-note">{data.candidates.length
      ? "No suggestions of this type were found for this sentence."
      : "No suggestions were found by the current rules. This does not mean the sentence has no connected speech."}</p>}
    <div className="stage-two-sound-legend" aria-label="Sound color legend">{kinds.map((value) => <span key={value} data-phenomenon={value}>{labels[value]}</span>)}</div>
    <details className="stage-two-sound-dictionary" hidden={textHidden}>
      <summary>Dictionary coverage · {data.coverage.known}/{data.coverage.total} words have one reading</summary>
      <p>Dictionary stress marks belong to individual words. They do not indicate which words the speaker stressed.</p>
      {unknown.length ? <p>Not in dictionary: {unknown.map((token) => token.text).join(", ")}. Their sounds are not guessed.</p> : null}
      {ambiguous.length ? <p>Multiple readings: {ambiguous.map((token) => token.text).join(", ")}. Rules that need one pronunciation skip these words.</p> : null}
      <ul>{data.tokens.map((token) => <li key={token.index}><strong>{token.text}</strong>
        <span>{token.ipa.length ? token.ipa.join(" · ") : "Pronunciation unavailable"}</span></li>)}</ul>
      <p>CMU Pronouncing Dictionary · {data.lexicon_version}</p>
      {data.warnings.length ? <ul className="stage-two-sound-warnings">{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
    </details>
    </div>
    <aside className="stage-two-layer-focus" aria-label="Sound layer focus">
      <div className="stage-two-layer-overview">
        <span className="stage-two-layer-overview-label">LAYER FOCUS · CONNECTED SPEECH</span>
        <strong>{textHidden ? "Let your ears lead" : "Notice how sounds connect"}</strong>
        <p>{textHidden ? "Listen with Play sentence, recall the words, then record your voice. Reveal a word whenever you need a hint."
          : "Listen for the highlighted sounds, then record and replay your voice. Select a suggestion to see what may change."}</p>
      </div>
      {selected && !textHidden ? <article className="stage-two-sound-detail" aria-label="Selected sound suggestion">
        <div className="stage-two-sound-detail-heading"><h3>{labels[selected.kind]} · {selected.source_text}</h3><span>Possible</span></div>
        <p className="stage-two-sound-phones"><span>{selected.phonemes_before}</span><span aria-label="may become">→</span><span>{selected.phonemes_after}</span></p>
        <p>{selected.explanation}</p>
        <ul className="stage-two-sound-conditions">{selected.conditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul>
        <dl className="stage-two-sound-evidence" aria-label="Sound evidence comparison">
          <div><dt>Reference</dt><dd><strong>{reference.label}</strong><span>{reference.reason}</span></dd></div>
          <div><dt>Your voice</dt><dd><strong>{yours.label}</strong><span>{yours.reason}</span></dd></div>
        </dl>
      </article> : null}
      <p className="stage-two-recording-note">Automatic checks for these sounds are not available yet; timing and pitch measurements cannot confirm them.</p>
    </aside>
  </div>;
}

function HighlightedSentence({ data, candidate }: { data: SoundAnnotation; candidate: SoundCandidate | null }) {
  if (!candidate) return data.sentence_text;
  const start = data.tokens[candidate.token_start].start;
  const end = data.tokens[candidate.token_end - 1].end;
  return <>{data.sentence_text.slice(0, start)}<mark>{data.sentence_text.slice(start, end)}</mark>{data.sentence_text.slice(end)}</>;
}
