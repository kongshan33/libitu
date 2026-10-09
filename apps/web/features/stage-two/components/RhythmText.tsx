"use client";

import { ContentSkeleton } from "@/components/ui/ContentSkeleton";

import { Button } from "@/components/ui/button";

import { Fragment, useMemo } from "react";
import type { SentenceUnit } from "@libitu/types/stage-two";
import type { AcousticFeatures } from "../acoustics/types";
import type { SentenceMeasurement } from "../server-reference/api";
import type { useSoundGuide } from "../sound/use-sound-guide";
import type { LocalReferenceDisplay } from "../alignment/display";
import { referenceRhythm, rhythmWords, type RhythmPause } from "../rhythm/rhythm-text";

export function RhythmText({ sentence, guide, reference, yours, server, originMs, localReference = null }: {
  sentence: SentenceUnit | null; guide: ReturnType<typeof useSoundGuide>;
  reference: AcousticFeatures | null; yours: AcousticFeatures | null;
  server: SentenceMeasurement | null; originMs: number | null;
  localReference?: LocalReferenceDisplay | null;
}) {
  const words = useMemo(() => rhythmWords(sentence?.text ?? "", guide.data), [sentence?.text, guide.data]);
  const rhythm = useMemo(() => sentence ? referenceRhythm(sentence, reference, server, originMs, localReference) : null,
    [sentence, reference, server, originMs, localReference]);
  if (!sentence || !rhythm) return <p>Select a sentence to see its rhythm.</p>;
  const marked = rhythm.pauses.filter(pause => pause.afterWord !== null);
  const unplaced = rhythm.pauses.filter(pause => pause.afterWord === null);
  const groups: { text: string; pause?: RhythmPause }[] = [];
  let from = 0;
  for (const pause of marked) {
    const end = words[pause.afterWord!]!.end;
    groups.push({ text: sentence.text.slice(from, end), pause });
    from = end;
  }
  groups.push({ text: sentence.text.slice(from) });
  return <div className="rhythm-text">
    <section aria-label="Word stress guide" className="rhythm-text-section">
      <div className="rhythm-section-heading"><h3>Word stress</h3><span>Dictionary guide</span></div>
      <p className="rhythm-help">One dot per syllable. Larger, darker dots mark stronger dictionary stress.</p>
      <div className="rhythm-stress-words" aria-label="Sentence with syllable stress marks">
        {words.map((word, index) => {
          const multiple = (word.stresses?.length ?? 0) > 1;
          const label = !word.stresses ? `${word.text}: stress pattern unavailable`
            : `${word.text}: ${word.stresses.map((stress, i) => `syllable ${i + 1} ${stress === 1 ? "primary stress" : stress === 2 ? "secondary stress" : "unstressed"}`).join(", ")}`;
          return <span className="rhythm-stress-word" key={index} aria-label={label} role="img" title={label}>
            <span className="rhythm-dots" aria-hidden="true">{word.stresses
              ? word.stresses.map((stress, syllable) => <i key={syllable} className={`rhythm-dot stress-${stress}`} />)
              : <span className="rhythm-unknown">—</span>}</span>
            <span className={multiple ? "rhythm-word-multi" : ""} aria-hidden="true">{word.text}</span>
          </span>;
        })}
      </div>
      <div className="rhythm-legend" aria-label="Stress legend">
        <span><i className="rhythm-dot stress-1" />Primary</span><span><i className="rhythm-dot stress-2" />Secondary</span>
        <span><i className="rhythm-dot stress-0" />Unstressed</span>
      </div>
      {guide.pending ? <ContentSkeleton label="Loading dictionary stress…" rows={1} /> : guide.error
        ? <p className="rhythm-help">Dictionary stress is unavailable. <Button variant="secondary" size="inherit" type="button" onClick={guide.retry}>Retry stress guide</Button></p> : null}
      <p className="rhythm-help">This helps you pronounce individual words; it does not identify which words the speaker emphasized. A dash means no single dictionary pattern is available.</p>
    </section>
    <section aria-label="Pauses in the sentence" className="rhythm-text-section">
      <div className="rhythm-section-heading"><h3>Phrases & pauses</h3><span>Detected gaps ≥ 0.20 s</span></div>
      <p className="rhythm-help">{!rhythm.aligned ? "Word positions unavailable" : rhythm.approximate ? "Caption positions · approximate" : localReference && !server ? "Local forced alignment · content not independently checked" : "Aligned word positions"}</p>
      <div className="rhythm-phrases" aria-label="Reference text with detected pauses">
        <span className="rhythm-phrase-label" aria-label="Reference">REF</span>
        <div className="rhythm-phrase-flow">
        {groups.map((group, index) => <Fragment key={index}><span className="rhythm-phrase">{group.text.trim()}</span>
          {group.pause ? <span className="rhythm-pause" role="img" aria-label={`${rhythm.approximate ? "Approximately after" : "After"} ${words[group.pause.afterWord!]!.text}: pause ${seconds(group.pause)} seconds`}>
            <span className="rhythm-pause-bar" aria-hidden="true" /><small aria-hidden="true">{rhythm.approximate ? "≈ " : ""}{seconds(group.pause)} s</small>
          </span> : null}</Fragment>)}
        </div>
      </div>
      {!rhythm.usable ? <p className="rhythm-help">Pause markers appear here after reference audio analysis.</p>
        : !rhythm.pauses.length ? <p className="rhythm-help">No internal pause of 0.20 s or longer was detected.</p>
          : marked.length ? <p className="rhythm-help">The vertical line shows a detected pause; the number is its duration.{rhythm.approximate ? " Its position in the text is approximate." : ""} A detected gap is not a judgment about where you should pause.</p> : null}
      {unplaced.length ? <><p className="rhythm-help">These pauses cannot yet be placed reliably between words. Times are from the start of this sentence’s audio.</p><PauseTimes pauses={unplaced} /></> : null}
      <div className="rhythm-your-voice">
        <div className="rhythm-voice-label">Your voice <span>Recording timing</span></div>
        {yours?.quality.status === "usable" ? <>
          <p className="rhythm-help">{yours.internalPauses.length ? "Detected pauses are shown by recording time. Word alignment is needed to place them in your text." : "No internal pause of 0.20 s or longer was detected in this take."}</p>
          <PauseTimes pauses={yours.internalPauses} />
        </> : <p className="rhythm-help">Record a take to see your pauses. Word-by-word stress comparison is not available yet.</p>}
      </div>
    </section>
  </div>;
}

const seconds = (pause: { startMs: number; endMs: number }) => ((pause.endMs - pause.startMs) / 1000).toFixed(2);
function PauseTimes({ pauses }: { pauses: { startMs: number; endMs: number }[] }) {
  return pauses.length ? <ul className="rhythm-pause-times">{pauses.map((pause, index) => <li key={index}>
    <span aria-hidden="true">Ⅱ</span> {(pause.startMs / 1000).toFixed(2)}–{(pause.endMs / 1000).toFixed(2)} s <strong>{seconds(pause)} s pause</strong>
  </li>)}</ul> : null;
}
