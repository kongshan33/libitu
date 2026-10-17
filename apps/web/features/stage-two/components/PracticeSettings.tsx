"use client";

import { useEffect, useRef } from "react";
import { Settings2 } from "lucide-react";
import { StageTwoSelect } from "./StageTwoSelect";
import type { TextSupport } from "../persistence/practice-api";

export function PracticeSettings({ rate, rates, mode, loop, scope, reviewing, disabled, hasSentence,
  onRate, onMode, onLoop, onScope }: {
  rate: number; rates: number[]; mode: TextSupport["mode"]; loop: boolean; scope: "sentence" | "segment";
  reviewing: boolean; disabled: boolean; hasSentence: boolean;
  onRate(rate: number): void; onMode(mode: TextSupport["mode"]): void;
  onLoop(): void; onScope(scope: "sentence" | "segment"): void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".ui-select-content")) return;
      if (event.target instanceof Node && !details.current?.contains(event.target)) details.current?.removeAttribute("open");
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && details.current?.open) {
        details.current.open = false;
        details.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", escape); };
  }, []);
  return <details ref={details} className="shadow-practice-settings">
    <summary aria-label="Practice settings"><Settings2 size={13} aria-hidden="true" />{rate}× · {loop ? "loop" : "no loop"}</summary>
    <div className="shadow-settings-content">
      <fieldset disabled={disabled || rates.length <= 1}><legend>Speed</legend>
        <div className="shadow-setting-segments">{Array.from(new Set([...rates, rate])).sort((a,b)=>a-b).map(value =>
          <button type="button" key={value} aria-label={`Playback speed ${value}×`} aria-pressed={rate === value} onClick={() => onRate(value)}>{value}×</button>)}</div>
      </fieldset>
      <fieldset disabled={disabled}><legend>{reviewing ? "Text for next take" : "Text"}</legend>
        <div className="shadow-setting-segments">{(["hidden", "keywords", "full"] as const).map(value =>
          <button type="button" key={value} aria-pressed={mode === value} onClick={() => onMode(value)}>{value === "hidden" ? "Hidden" : value === "keywords" ? "Key words" : "Full"}</button>)}</div>
      </fieldset>
      <label className="shadow-settings-loop"><input type="checkbox" checked={loop} disabled={disabled} onChange={onLoop} />Loop {scope === "segment" ? "the segment" : "the sentence"}</label>
      <StageTwoSelect label="Range" ariaLabel="Playback range" value={hasSentence ? scope : "segment"} disabled={disabled}
        options={[{ value: "sentence", label: "Sentence", disabled: !hasSentence }, { value: "segment", label: "Whole segment" }]}
        onValueChange={value => onScope(value as "sentence" | "segment")} />
      <p className="shadow-settings-shortcuts"><kbd>Space</kbd> listen · <kbd>R</kbd> record / stop</p>
    </div>
  </details>;
}
