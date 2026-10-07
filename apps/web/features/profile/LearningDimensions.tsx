"use client";

import { useState } from "react";
import { AudioLines, BookOpen, MessageCircle, PenLine, Target } from "lucide-react";
import styles from "./Profile.module.css";

const dimensions = [
  { name: "Pronunciation", icon: AudioLines, detail: "Explore Sound, Rhythm and Melody in shadowing. Saved measurements describe your recording; a validated pronunciation score is not available yet." },
  { name: "Expression", icon: MessageCircle, detail: "Mission reports assess task fit, language transfer and text naturalness for one conversation. An overall expression ability score is not available yet." },
  { name: "Pragmatics", icon: Target, detail: "Mission reports include scenario-fit feedback for a specific conversation. This does not establish a general pragmatics ability score." },
  { name: "Intake", icon: BookOpen, detail: "Build your corpus from real English. Saved-item counts track your collection; they do not measure listening or reading comprehension." },
  { name: "Writing", icon: PenLine, detail: "A dedicated writing practice and assessment experience is not available yet." }
];

export function LearningDimensions() {
  const [active, setActive] = useState(0);
  return <section className={styles.card} aria-labelledby="dimensions-title">
    <div className={styles.cardHeader}><h2 id="dimensions-title">Learning dimensions</h2><span className={styles.smallMuted}>Assessment pending</span></div>
    <div className={styles.dimensionBody}>
      <div className={styles.radarArea}>
        <svg viewBox="0 0 210 190" aria-hidden="true">
          {[1, 0.66, 0.33].map((scale) => <polygon key={scale} points={Array.from({ length: 5 }, (_, i) => {
            const angle = (i * 72 - 90) * Math.PI / 180;
            return `${105 + Math.cos(angle) * 79 * scale},${96 + Math.sin(angle) * 79 * scale}`;
          }).join(" ")} fill="none" stroke="var(--color-border-secondary)" strokeDasharray="3 4" />)}
          {Array.from({ length: 5 }, (_, i) => { const angle = (i * 72 - 90) * Math.PI / 180; return <line key={i} x1="105" y1="96" x2={105 + Math.cos(angle) * 79} y2={96 + Math.sin(angle) * 79} stroke="var(--color-border-tertiary)" />; })}
          <circle cx="105" cy="96" r="28" fill="var(--color-background-primary)" />
          <text x="105" y="101" textAnchor="middle" fill="var(--color-text-secondary)" fontSize="20">—</text>
        </svg>
        <p>Your learning has more<br />than one dimension.</p>
      </div>
      <div className={styles.dimensionList} role="group" aria-label="Learning dimensions">
        {dimensions.map((dimension, index) => <button type="button" key={dimension.name} aria-pressed={active === index} aria-controls="dimension-detail" onClick={() => setActive(index)}>
          <dimension.icon size={16} aria-hidden="true" /><span>{dimension.name}<small>{index === 4 ? "Not available yet" : "Not assessed"}</small></span><b aria-hidden="true">—</b>
        </button>)}
      </div>
    </div>
    <div id="dimension-detail" className={styles.dimensionDetail} aria-live="polite"><strong>{dimensions[active].name}</strong><p>{dimensions[active].detail}</p></div>
  </section>;
}
