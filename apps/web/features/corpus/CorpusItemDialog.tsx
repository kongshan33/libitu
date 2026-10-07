"use client";

import { Textarea } from "@/components/ui/field";

import { Button } from "@/components/ui/button";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { X, ExternalLink } from "lucide-react";
import type { CorpusSelectionAnalysis, CorpusSelectionContext, FunctionalTag } from "@libitu/types/stage-one";
import type { CorpusEdit, SavedCorpusRecord } from "./corpus-storage";
import { ExplainPanel, SyntaxPanel } from "./AnalysisPanels";
import { analyzeCorpusSelection } from "../stage-one/api/stage-one-api";
import { expressionText } from "../loadout/draft";
import { functionalTags, sourceHref } from "./library";
import styles from "./CorpusLibrary.module.css";

type Props = {
  record: SavedCorpusRecord; busy: boolean; error: string | null; initialEdit: boolean;
  onClose(): void;
  onUpdate(record: SavedCorpusRecord, edit: CorpusEdit): Promise<boolean>;
  onRemove(record: SavedCorpusRecord): Promise<boolean>;
  onHydrate(record: SavedCorpusRecord, context: CorpusSelectionContext, analyze: () => Promise<CorpusSelectionAnalysis>): Promise<SavedCorpusRecord | null>;
};
export function CorpusItemDialog({ record, busy, error, initialEdit, onClose, onUpdate, onRemove, onHydrate }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState(initialEdit);
  const [tab, setTab] = useState<"explain" | "syntax">("explain");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<CorpusEdit>(() => ({ text: expressionText(record), meaning: record.item.meaning ?? "", usageNote: record.item.usageNote ?? "", tags: record.item.tags, slots: record.item.slots ?? {} }));
  const [slots, setSlots] = useState(JSON.stringify(record.item.slots ?? {}, null, 2));
  const started = useRef(false);
  const detail = record.item.analysisDetail;
  const original = record.item.sourceText;
  const href = sourceHref(record);
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => { node?.close(); }; }, []);
  async function hydrate() {
    if (!original || busy) return;
    setNotice(null);
    const context: CorpusSelectionContext = { contentId: record.contentId, selectedText: original, currentSentence: original,
      timestamp: record.item.meta.match(/^\s*(\d{1,2}:\d{2}(?::\d{2})?)/)?.[1] };
    const result = await onHydrate(record, context, () => analyzeCorpusSelection(context));
    if (!result) setNotice("Analysis could not be loaded. Please retry.");
  }
  useEffect(() => {
    if (started.current || editing || detail || !original || busy) return;
    started.current = true;
    void hydrate();
  });
  async function save() {
    setNotice(null);
    try {
      const parsed = JSON.parse(slots) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || !Object.values(parsed).every((value) => typeof value === "string")) throw new Error("Slots must be an object with text values, for example {\"A\": \"a concern\"}.");
      if (!draft.text.trim()) throw new Error("Enter an expression or structure.");
      if (await onUpdate(record, { ...draft, text: draft.text.trim(), slots: parsed as Record<string, string> })) { setEditing(false); setNotice("Changes saved."); }
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : "Could not save changes."); }
  }
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="library-detail-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className={styles.dialogHeader}><div><span className={styles.eyebrow}>{record.item.kind} · {editing ? "Edit saved item" : "Corpus detail"}</span><h2 id="library-detail-title">{expressionText(record)}</h2></div><Button variant="ghost" size="inherit" type="button" className={styles.iconButton} disabled={busy} aria-label="Close corpus detail" onClick={onClose}><X size={20} /></Button></header>
    <div className={styles.dialogBody}>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      {notice ? <p role="status" className={styles.notice}>{notice}</p> : null}
      {editing ? <form onSubmit={(event) => { event.preventDefault(); void save(); }} className={styles.form}>
        <label>Expression or structure<Textarea aria-label="Expression or structure" required maxLength={2000} value={draft.text} onChange={(event) => setDraft({ ...draft, text: event.target.value })} /></label>
        <label>Meaning<Textarea aria-label="Meaning" maxLength={4000} value={draft.meaning} onChange={(event) => setDraft({ ...draft, meaning: event.target.value })} /></label>
        <label>Usage note<Textarea aria-label="Usage note" maxLength={4000} value={draft.usageNote} onChange={(event) => setDraft({ ...draft, usageNote: event.target.value })} /></label>
        <fieldset className={styles.tagEditor}><legend>Functional tags</legend>{[...new Set([...functionalTags, ...record.item.tags])].map((tag) => <label key={tag}><input type="checkbox" checked={draft.tags.includes(tag)} onChange={() => setDraft({ ...draft, tags: draft.tags.includes(tag) ? draft.tags.filter((value) => value !== tag) : [...draft.tags, tag as FunctionalTag] })} />{tag}</label>)}</fieldset>
        {record.item.kind === "structure" ? <label>Slots (JSON)<Textarea aria-label="Slots (JSON)" value={slots} onChange={(event) => setSlots(event.target.value)} spellCheck={false} /></label> : null}
        <p className={styles.help}>The original source and its analysis stay attached as evidence. Your edits update the saved item used in future missions.</p>
        <div className={styles.actions}><Button variant="secondary" size="inherit" type="button" disabled={busy} onClick={() => { setEditing(false); setNotice(null); }}>Cancel edit</Button><Button variant="primary" size="inherit" type="submit" className={styles.primary} loading={busy} loadingLabel="Saving…">Save changes</Button></div>
      </form> : <>
        <p className={styles.meaning}>{record.item.meaning || "No meaning saved."}</p>
        {record.item.usageNote ? <p>{record.item.usageNote}</p> : null}
        <div className={styles.actions}><Button variant="secondary" size="inherit" type="button" disabled={busy} onClick={() => { setDraft({ text: expressionText(record), meaning: record.item.meaning ?? "", usageNote: record.item.usageNote ?? "", tags: record.item.tags, slots: record.item.slots ?? {} }); setSlots(JSON.stringify(record.item.slots ?? {}, null, 2)); setEditing(true); }}>Edit item</Button><Button variant="danger" size="inherit" type="button" className={styles.danger} disabled={busy} onClick={() => setConfirmDelete(true)}>Delete item</Button></div>
        {confirmDelete ? <div className={styles.deleteNotice} role="alert"><p>Delete this saved item? Its source and past mission transcripts will remain.</p><div className={styles.actions}><Button variant="secondary" size="inherit" type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep item</Button><Button variant="danger-solid" size="inherit" type="button" className={styles.danger} disabled={busy} loading={busy} loadingLabel="Deleting…" onClick={async () => { if (await onRemove(record)) onClose(); }}>Confirm delete</Button></div></div> : null}
        <section className={styles.context}><div className={styles.sourceHeading}><strong>{record.sourceTitle || "Personal corpus"}</strong>{href ? <Link href={href} {...(href.startsWith("/") ? {} : { target: "_blank", rel: "noreferrer" })}>Open source <ExternalLink size={13} /></Link> : null}</div>
          {detail?.context.contextBefore ? <p>{detail.context.contextBefore}</p> : null}
          <blockquote>{detail?.context.currentSentence || original || "Original source context was not saved."}</blockquote>
          {detail?.context.contextAfter ? <p>{detail.context.contextAfter}</p> : null}
          {detail?.context.timestamp ? <small>Source time · {detail.context.timestamp}</small> : null}
        </section>
        {detail ? <><p className={styles.help}>Original analysis · {detail.context.selectedText}</p>
          {detail.analysis.analysisSource === "fallback" ? <p className={styles.notice}>{detail.analysis.providerNotice || "AI analysis was unavailable. This is a limited fallback."}</p> : null}
          <div className={styles.tabs} aria-label="Analysis views"><button type="button" aria-pressed={tab === "explain"} onClick={() => setTab("explain")}>Explain</button><button type="button" aria-pressed={tab === "syntax"} onClick={() => setTab("syntax")}>Syntax</button></div>
          {tab === "explain" ? <ExplainPanel analysis={detail.analysis} isLoading={false} /> : <SyntaxPanel analysis={detail.analysis} isLoading={false} saveDisabled />}</>
          : busy ? <p role="status">Loading original analysis…</p> : original ? <Button variant="secondary" size="inherit" type="button" onClick={() => void hydrate()}>Load original analysis</Button> : <p className={styles.help}>Full analysis is unavailable without saved source evidence. You can still edit and practice this item.</p>}
      </>}
    </div>
  </dialog>;
}
