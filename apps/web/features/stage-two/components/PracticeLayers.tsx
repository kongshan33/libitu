"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { AudioLines, ChartNoAxesCombined, Music2 } from "lucide-react";
import type { LayerBadge } from '../practice/layer-presentation';

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

export function PracticeLayers({ active, onChange, sound, rhythm, melody, badges, locked, gate }: SelectionProps & {
  sound: ReactNode; rhythm: ReactNode; melody: ReactNode; badges?: Partial<Record<PracticeLayer, LayerBadge>>;
  locked?: Partial<Record<PracticeLayer, boolean>>; gate?: ReactNode;
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
    const enabled = practiceLayers.map((entry,i)=>({entry,i})).filter(({entry})=>!locked?.[entry.id]);
    if(!enabled.length)return;
    const candidate = event.key==='Home'?enabled[0]:event.key==='End'?enabled[enabled.length-1]:
      enabled.find(({i})=>i===next)??(event.key==='ArrowLeft'?enabled[enabled.length-1]:enabled[0]);
    onChange(candidate.entry.id);
    tabs.current[candidate.i]?.focus();
  }
  return <div className="stage-two-layers">
    <div className="stage-two-layer-tabs" role="tablist" aria-label="Practice layers">
      {practiceLayers.map(({ id: layer, label, description, icon: Icon }, index) => <button key={layer}
        ref={(element) => { tabs.current[index] = element; }} type="button" role="tab" data-layer={layer}
        id={`${id}-tab-${layer}`} aria-controls={`${id}-panel-${layer}`} aria-selected={active === layer}
        aria-describedby={badges?.[layer] ? `${id}-status-${layer}` : undefined}
        aria-label={label} disabled={locked?.[layer]} tabIndex={active === layer&&!locked?.[layer] ? 0 : -1} onClick={() => onChange(layer)}
        onKeyDown={(event) => navigate(event, index)}>
        <span><Icon aria-hidden="true" />{label}{badges?.[layer] ? <em className="paired-tab-badge" data-state={badges[layer].state}
          id={`${id}-status-${layer}`} title={badges[layer].title} aria-label={badges[layer].title}>{badges[layer].text}</em> : null}</span><small aria-hidden="true">{description}</small>
      </button>)}
    </div>
    {locked?.[active]?<div className="shadow-layer-gate" role="status">{gate??'Complete a word check to compare your take.'}</div>:null}
    {practiceLayers.map(({ id: layer }) => <div key={layer} role="tabpanel" tabIndex={0}
      id={`${id}-panel-${layer}`} aria-labelledby={`${id}-tab-${layer}`} hidden={active !== layer||Boolean(locked?.[layer])} data-layer={layer}>
      {locked?.[layer] ? null : content[layer]}
    </div>)}
  </div>;
}
