"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { SpeakingHelpCard, SpeakingHelpLevel } from "@libitu/types/speaking";
import { Button } from "@/components/ui/button";
import { observeVisible } from "./visibility";
import styles from "./Speaking.module.css";

function ShownSection({ children, card, level, active, onShown }: { children: ReactNode; card: SpeakingHelpCard; level: SpeakingHelpLevel; active: boolean; onShown: (id: string, version: number, level: SpeakingHelpLevel) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || card.version < 1 || !ref.current) return;
    return observeVisible(ref.current, () => onShown(card.id, card.version, level));
  }, [active, card.id, card.version, level, onShown]);
  return <div ref={ref}>{children}</div>;
}

export function HintCard({ card, connected, userSpeaking, onHint, onShown }: {
  card: SpeakingHelpCard | null; connected: boolean; userSpeaking: boolean;
  onHint: (level: "usage" | "example", targetItemId?: string) => void;
  onShown: (id: string, version: number, level: SpeakingHelpLevel) => void;
}) {
  if (!card || (card.source === "automatic" && userSpeaking)) return null;
  const target = card.target_item_id ?? undefined;
  const hasUsage = card.level !== "direction" && !!card.expression;
  const hasExample = card.level === "example" && card.status === "ready" && !!card.example;
  return <section className={styles.helpCard} aria-label="Speaking hint" aria-busy={card.status === "loading"}>
    <h2>{card.source === "automatic" ? "An idea for your next reply" : "A little help for your reply"}</h2>
    {card.direction ? <ShownSection card={card} level="direction" active={connected} onShown={onShown}><p className={styles.helpDirection}>{card.direction}</p></ShownSection> : null}
    {hasUsage ? <ShownSection card={card} level="usage" active={connected} onShown={onShown}>
      <p className={styles.helpExpression}>{card.expression}</p>
      {card.meaning ? <p>{card.meaning}</p> : null}
      {card.pattern ? <p><span className={styles.helpLabel}>Sentence pattern</span>{card.pattern}</p> : null}
    </ShownSection> : null}
    {hasExample ? <ShownSection card={card} level="example" active={connected} onShown={onShown}>
      <p className={styles.helpLabel}>One example</p><blockquote>{card.example}</blockquote>
      {card.substitution ? <p>{card.substitution}</p> : null}
    </ShownSection> : null}
    {card.status === "loading" ? <p role="status">{card.level === "example" ? "Writing an example for this conversation…" : "Finding a helpful way to say it…"}</p> : null}
    {card.status === "unavailable" ? <p role="status">{card.error || "More help is unavailable right now. You can try again."}</p> : null}
    <div className={styles.helpActions}>
      {card.level === "direction" ? <Button variant="secondary" size="inherit" type="button" disabled={!connected} onClick={() => onHint("usage", target)}>How can I use it?</Button> : null}
      {card.level !== "direction" && !hasExample && card.status !== "loading" ? <Button variant="secondary" size="inherit" type="button" disabled={!connected} onClick={() => onHint("example", target)}>{card.status === "unavailable" && card.level === "example" ? "Try example again" : "Show an example"}</Button> : null}
      {card.status === "unavailable" && card.level === "usage" ? <Button variant="secondary" size="inherit" type="button" disabled={!connected} onClick={() => onHint("usage", target)}>Try hint again</Button> : null}
    </div>
  </section>;
}
