"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { AudioLines, ChartNoAxesCombined, Music2 } from "lucide-react";

export const practiceLayers = [
  { id: "sound", label: "Sound", description: "Phonemes · connected speech", icon: AudioLines },
  { id: "rhythm", label: "Rhythm", description: "Stress guide · pauses", icon: ChartNoAxesCombined },
  { id: "melody", label: "Melody", description: "Pitch · intonation", icon: Music2 }
] as const;
export type PracticeLayer = (typeof practiceLayers)[number]["id"];

type SelectionProps = { active: PracticeLayer; onChange(layer: PracticeLayer): void };

export function PracticeLayerShortcuts({ active, onChange }: SelectionProps) {
  return <div className="stage-two-layer-shortcuts" role="group" aria-label="Layer shortcuts">
    <h2>Practice layers</h2>
    {practiceLayers.map(({ id, label, description, icon: Icon }) => <button key={id} type="button"
      data-layer={id} aria-label={`Focus ${label} layer`} aria-pressed={active === id} onClick={() => onChange(id)}>
      <span className="stage-two-layer-icon"><Icon aria-hidden="true" /></span>
      <span><strong>{label}</strong><small>{description}</small></span>
      <span className="stage-two-layer-dot" aria-hidden="true" />
    </button>)}
  </div>;
}

export function PracticeLayers({ active, onChange, sound, rhythm, melody, badges }: SelectionProps & {
  sound: ReactNode; rhythm: ReactNode; melody: ReactNode; badges?: Partial<Record<PracticeLayer, string>>;
}) {
  const id = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const content = { sound, rhythm, melody };
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = event.key === "ArrowRight" ? (index + 1) % practiceLayers.length
      : event.key === "ArrowLeft" ? (index + practiceLayers.length - 1) % practiceLayers.length
        : event.key === "Home" ? 0 : event.key === "End" ? practiceLayers.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    onChange(practiceLayers[next].id);
    tabs.current[next]?.focus();
  }
  return <div className="stage-two-layers">
    <div className="stage-two-layer-tabs" role="tablist" aria-label="Practice layers">
      {practiceLayers.map(({ id: layer, label, description, icon: Icon }, index) => <button key={layer}
        ref={(element) => { tabs.current[index] = element; }} type="button" role="tab" data-layer={layer}
        id={`${id}-tab-${layer}`} aria-controls={`${id}-panel-${layer}`} aria-selected={active === layer}
        aria-label={label} tabIndex={active === layer ? 0 : -1} onClick={() => onChange(layer)}
        onKeyDown={(event) => navigate(event, index)}>
        <span><Icon aria-hidden="true" />{label}{badges?.[layer] ? <em className="paired-tab-badge">{badges[layer]}</em> : null}</span><small aria-hidden="true">{description}</small>
      </button>)}
    </div>
    {/* Keep the panels mounted: changing focus must not restart guide requests or audio work. */}
    {practiceLayers.map(({ id: layer }) => <div key={layer} role="tabpanel" tabIndex={0}
      id={`${id}-panel-${layer}`} aria-labelledby={`${id}-tab-${layer}`} hidden={active !== layer} data-layer={layer}>
      {content[layer]}
    </div>)}
  </div>;
}
