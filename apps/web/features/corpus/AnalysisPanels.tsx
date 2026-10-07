"use client";

import { Button } from "@/components/ui/button";

import { Volume2 } from "lucide-react";
import type { CorpusKind, CorpusSelectionAnalysis } from "@libitu/types/stage-one";

export function ExplainPanel({ analysis, isLoading }: { analysis: CorpusSelectionAnalysis; isLoading: boolean }) {
  return (
    <div className="analysis-stack">
      <section>
        <h2>Pronunciation</h2>
        <p><strong>{analysis.explanation.pronunciation.ipa}</strong></p>
        <p>{analysis.explanation.pronunciation.connectedSpeech}</p>
        <Button variant="secondary" size="inherit" className="inline-command" type="button" disabled={isLoading} onClick={() => speakText(analysis.explanation.pronunciation.audioText)}>
          <Volume2 size={13} aria-hidden="true" />
          Play
        </Button>
      </section>
      <section>
        <h2>Meaning and function</h2>
        <p>{analysis.explanation.meaning}</p>
        <p>{analysis.explanation.pragmaticFunction}</p>
      </section>
      <section>
        <h2>Similar expressions</h2>
        <div className="mini-chip-row">
          {analysis.explanation.similarExpressions.map((expression) => <span key={expression}>{expression}</span>)}
          {analysis.explanation.similarExpressions.length === 0 ? <span>{isLoading ? "Analyzing..." : "No alternatives available"}</span> : null}
        </div>
      </section>
      <section>
        <h2>Examples</h2>
        {analysis.explanation.examples.map((example) => (
          <p className="example-line" key={example.english}>
            {example.typical ? <span>Typical</span> : null}
            {example.english}<br />
            <small>{example.chinese}</small>
          </p>
        ))}
      </section>
      <div className="mini-chip-row">
        {analysis.explanation.usageChips.map((chip) => <span key={chip}>{chip}</span>)}
      </div>
    </div>
  );
}

export function SyntaxPanel({
  analysis,
  isLoading,
  onSavePattern,
  saveDisabled
}: {
  analysis: CorpusSelectionAnalysis;
  isLoading: boolean;
  onSavePattern?: (kindOverride?: CorpusKind, textOverride?: string, slots?: Record<string, string>) => void;
  saveDisabled: boolean;
}) {
  return (
    <div className="analysis-stack">
      <section>
        <h2>Sentence structure</h2>
        <p><strong>{analysis.syntaxAnalysis.sentenceType}</strong></p>
        <p>{analysis.syntaxAnalysis.mainClause}</p>
        <AnalysisItems items={analysis.syntaxAnalysis.structureBreakdown} emptyLabel={isLoading ? "Analyzing..." : "No additional breakdown."} />
      </section>
      <AnalysisList title="Logic relations" items={analysis.syntaxAnalysis.logicRelations} isLoading={isLoading} />
      <AnalysisList title="Information hierarchy" items={analysis.syntaxAnalysis.informationHierarchy} isLoading={isLoading} />
      <AnalysisList title="Style" items={analysis.syntaxAnalysis.styleFeatures} isLoading={isLoading} />
      <AnalysisList title="Usage scenarios" items={analysis.syntaxAnalysis.usageScenarios} isLoading={isLoading} />
      <AnalysisList title="Grammar focus" items={analysis.syntaxAnalysis.grammarPoints} isLoading={isLoading} />
      <AnalysisList title="Wording" items={analysis.syntaxAnalysis.wordingNotes} isLoading={isLoading} />
      <section>
        <h2>Reusable structures</h2>
        {analysis.syntaxAnalysis.reusablePatterns.map((pattern) => (
          <article className="pattern-row" key={pattern.template}>
            <code>{pattern.template}</code>
            <p>{pattern.rationale}</p>
            {onSavePattern ? (
              <Button variant="primary" size="inherit" className="inline-command" type="button" disabled={isLoading || saveDisabled} onClick={() => onSavePattern("structure", pattern.template, pattern.slots)}>
                Save structure
              </Button>
            ) : null}
          </article>
        ))}
        {analysis.syntaxAnalysis.reusablePatterns.length === 0 ? <p>{isLoading ? "Preparing reusable patterns." : "No reusable structures in this analysis."}</p> : null}
      </section>
      <section>
        <h2>Translations</h2>
        {analysis.syntaxAnalysis.translations.map((translation) => (
          <div className="translation-version" key={`${translation.label}-${translation.text}`}>
            <strong>{translation.label}{translation.recommended ? " · Recommended" : ""}</strong>
            <p>{translation.text}</p>
          </div>
        ))}
        {analysis.syntaxAnalysis.translations.length === 0 ? <p>{isLoading ? "Preparing translations." : "No translations in this analysis."}</p> : null}
      </section>
      <AnalysisList title="Translation notes" items={analysis.syntaxAnalysis.translationNotes} isLoading={isLoading} />
      {analysis.syntaxAnalysis.backgroundContext ? (
        <section>
          <h2>Background</h2>
          <p>{analysis.syntaxAnalysis.backgroundContext}</p>
        </section>
      ) : null}
      <AnalysisList title="Evidence" items={analysis.syntaxAnalysis.evidence} isLoading={isLoading} />
    </div>
  );
}

function AnalysisList({ title, items, isLoading }: { title: string; items: string[]; isLoading: boolean }) {
  return (
    <section>
      <h2>{title}</h2>
      <AnalysisItems items={items} emptyLabel={isLoading ? "Analyzing..." : "No additional analysis."} />
    </section>
  );
}

function AnalysisItems({ items, emptyLabel }: { items: string[]; emptyLabel: string }) {
  if (items.length === 0) return <p>{emptyLabel}</p>;
  return (
    <ol className="analysis-list">
      {items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
    </ol>
  );
}

function speakText(text: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}
