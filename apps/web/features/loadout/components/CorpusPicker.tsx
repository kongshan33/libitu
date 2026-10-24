"use client";

import { Check, Plus } from "lucide-react";
import type { SavedCorpusRecord } from "../../corpus/corpus-storage";
import { expressionText } from "../draft";
import styles from "./Loadout.module.css";

export function CorpusPicker({ title, records, selectedKeys, count, limit, structures = false, disabled, onToggle }: {
  title: string; records: SavedCorpusRecord[]; selectedKeys: string[]; count: number; limit: number;
  structures?: boolean; disabled: boolean; onToggle(record: SavedCorpusRecord): void;
}) {
  return <fieldset className={styles.picker}>
    <legend>{title}</legend>
    <div className={styles.pickerHeading}><p>{title === "Function not yet labelled" ? "No functional tag is saved for these items." : "Language for this communicative function."}</p><span aria-live="polite">{count} / {limit} total selected</span></div>
    {count >= limit ? <p className={styles.limitNotice}>All {limit} slots are filled. Remove an item to choose another.</p> : null}
    <div className={structures ? styles.structureList : styles.expressionGrid}>
      {records.map((record) => {
        const selected = selectedKeys.includes(record.key);
        const text = expressionText(record);
        return <button className={`${styles.corpusCard} ${selected ? styles.selectedCard : ""}`} type="button" key={record.key}
          aria-label={`${selected ? "Remove" : "Select"} ${text}`} aria-pressed={selected}
          disabled={disabled || (!selected && count >= limit)} onClick={() => onToggle(record)}>
          <span className={styles.cardToggle} aria-hidden="true">{selected ? <Check size={14} /> : <Plus size={14} />}</span>
          <span className={record.item.kind === "structure" ? styles.structureText : styles.expressionText}>{text}</span>
          {record.item.meaning ? <span className={styles.meaning}>{record.item.meaning}</span> : null}
          <span className={styles.tags}><span className={styles.kindTag}>{record.item.kind}</span>{record.item.tags.map((tag) => <span key={tag}>{tag}</span>)}</span>
          <span className={styles.source}>{record.sourceTitle || "Personal corpus"}{!record.serverId ? " · Saved on this device" : ""}</span>
        </button>;
      })}
    </div>
    {!records.length ? <p className={styles.empty}>No {structures ? "structures" : "expressions"} match these filters.</p> : null}
  </fieldset>;
}
