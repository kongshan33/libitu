"use client";

import { ContentSkeleton } from "@/components/ui/ContentSkeleton";

import { DirectionButton, DirectionLink } from "@/components/ui/direction-button";

import { SelectField } from "@/components/ui/select";

import { AppHeader } from "@/components/AppHeader";

import { Input } from "@/components/ui/field";

import { Button } from "@/components/ui/button";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth, useClerk } from "@clerk/nextjs";
import { useDeferredValue, useMemo, useState } from "react";
import { ArrowRight, BookOpen, Search, LayoutGrid, List, SlidersHorizontal, Pencil, Sparkles } from "lucide-react";
import { useSavedCorpus } from "./useSavedCorpus";
import { CorpusItemDialog } from "./CorpusItemDialog";
import { addCorpusToDraft, expressionText } from "../loadout/draft";
import { emptyFilters, libraryItems, sourceKey, type LibraryFilters, type LibrarySort } from "./library";
import styles from "./CorpusLibrary.module.css";

type FacetKey = "kind" | "tags" | "level" | "register" | "scenario" | "source";
export function CorpusLibrary() {
  const { isLoaded, userId } = useAuth();
  return <main className={styles.page}>
    <AppHeader active="corpus" />
    {isLoaded ? <LibraryContent key={userId ?? "guest"} owner={userId ?? null} /> : <ContentSkeleton label="Loading your library…" variant="cards" />}
  </main>;
}
function LibraryContent({ owner }: { owner: string | null }) {
  const corpus = useSavedCorpus();
  const clerk = useClerk();
  const router = useRouter();
  const [filters, setFilters] = useState<LibraryFilters>(emptyFilters);
  const [sort, setSort] = useState<LibrarySort>("recent");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<string[]>([]);
  const [active, setActive] = useState<{ key: string; edit: boolean } | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const query = useDeferredValue(filters.query);
  const visible = useMemo(() => libraryItems(corpus.records, { ...filters, query }, sort), [corpus.records, filters, query, sort]);
  const selectedKeys = selected.filter((key) => corpus.records.some((record) => record.key === key));
  const hidden = selectedKeys.filter((key) => !visible.some((record) => record.key === key)).length;
  const activeRecord = corpus.records.find((record) => record.key === active?.key);
  const disabled = !corpus.ready || corpus.busy || adding;
  const kinds = ["chunk", "idiom", "structure"];
  const tags = [...new Set(corpus.records.flatMap((record) => record.item.tags))].sort();
  const scenarios = [...new Set(corpus.records.flatMap((record) => record.item.scenarioTags ?? []))].sort();
  const sources = [...new Map(corpus.records.map((record) => [sourceKey(record), record.sourceTitle || "Personal corpus"])).entries()];
  function toggleFacet(field: FacetKey, value: string) {
    setFilters((current) => ({ ...current, [field]: current[field].includes(value) ? current[field].filter((item) => item !== value) : [...current[field], value] }));
  }
  function toggleSelected(key: string) { setSelected((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key]); setMessage(null); }
  async function addToLoadout() {
    if (disabled || !selectedKeys.length) return;
    setAdding(true); setMessage(null);
    try {
      const draft = await addCorpusToDraft(window.localStorage, owner, selectedKeys, corpus.records, {
        isCurrent: () => clerk.loaded && (clerk.user?.id ?? null) === owner
      });
      if (draft && (clerk.user?.id ?? null) === owner) router.push("/loadout?returnTo=%2Fcorpus");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save your loadout. Please retry."); }
    finally { setAdding(false); }
  }
  const filterContent = <>
      <div className={styles.overview}><span className={styles.eyebrow}>Your collection</span><strong>{corpus.records.length}<small>saved items</small></strong><div className={styles.counts}>{kinds.map((kind) => <span key={kind}><b>{corpus.records.filter((record) => record.item.kind === kind).length}</b>{kind}s</span>)}</div></div>
      <Facet title="Type" values={kinds} selected={filters.kind} onToggle={(value) => toggleFacet("kind", value)} />
      <Facet title="Functional tags" values={tags} selected={filters.tags} onToggle={(value) => toggleFacet("tags", value)} />
      <Facet title="Difficulty" values={["A1", "A2", "B1", "B2", "C1", "C2", "unknown"]} selected={filters.level} onToggle={(value) => toggleFacet("level", value)} />
      <Facet title="Scenario" values={[...scenarios, "unknown"]} selected={filters.scenario} onToggle={(value) => toggleFacet("scenario", value)} />
      <Facet title="Register" values={["professional", "neutral", "casual", "formal", "unknown"]} selected={filters.register} onToggle={(value) => toggleFacet("register", value)} />
      <Facet title="Source" values={sources.map(([key]) => key)} labels={Object.fromEntries(sources.map(([key, title]) => [key, `${title} (${corpus.records.filter((record) => sourceKey(record) === key).length})`]))} selected={filters.source} onToggle={(value) => toggleFacet("source", value)} />
      <Button variant="ghost" size="inherit" type="button" className={styles.reset} onClick={() => setFilters(emptyFilters)}>Reset all filters</Button>
  </>;
  return <div className={styles.shell}>
    <aside className={styles.sidebar} aria-label="Corpus filters">{filterContent}</aside>
    <section className={styles.main} aria-labelledby="library-title">
      <div className={styles.heading}><div><span className={styles.eyebrow}>From saved to spoken</span><h1 id="library-title">Corpus library</h1><p>Keep useful language close. Make it part of your next conversation.</p></div><DirectionLink className={styles.practiceLink} href="/loadout">Open Loadout <ArrowRight size={15} /></DirectionLink></div>
      {!owner ? <p className={styles.guestNotice}>Saved on this device. Sign in to sync your collection across devices.</p> : null}
      <div className={styles.tabs}><button type="button" aria-pressed={!filters.highValue} onClick={() => setFilters({ ...filters, highValue: false })}>All items</button><button type="button" aria-pressed={filters.highValue} onClick={() => setFilters({ ...filters, highValue: true })}><Sparkles size={14} /> High value</button></div>
      <div className={styles.toolbar}><label className={`ui-field-surface ${styles.search}`} data-field-surface><Search size={17} aria-hidden="true" /><Input appearance="bare" aria-label="Search corpus" type="search" placeholder="Search expressions, meanings, tags…" value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} /></label><SelectField aria-label="Sort corpus" value={sort} onValueChange={(value) => setSort(value as LibrarySort)} options={[{ value: "recent", label: "Recently added" }, { value: "value", label: "Learning value ↓" }, { value: "transfer", label: "Transferability ↓" }, { value: "alphabetical", label: "Alphabetical" }]} /><div className={styles.viewToggle}><button type="button" aria-label="Grid view" aria-pressed={view === "grid"} onClick={() => setView("grid")}><LayoutGrid size={17} /></button><button type="button" aria-label="List view" aria-pressed={view === "list"} onClick={() => setView("list")}><List size={17} /></button></div><Button variant="secondary" size="inherit" type="button" className={styles.filterToggle} aria-controls="mobile-corpus-filters" aria-expanded={filterOpen} onClick={() => setFilterOpen(!filterOpen)}><SlidersHorizontal size={16} /> Filters</Button></div>
      {filterOpen ? <aside id="mobile-corpus-filters" className={styles.mobileFilters} aria-label="Corpus filters">{filterContent}</aside> : null}
      {filters.highValue ? <p className={styles.help}>Learning value of 4 or 5 out of 5. Items without a score are not included.</p> : null}
      {corpus.error ? <div role="alert" className={styles.error}><p>{corpus.error}</p><Button variant="secondary" size="inherit" type="button" disabled={corpus.busy} loading={corpus.busy} loadingLabel="Syncing…" onClick={corpus.retry}>Retry corpus sync</Button></div> : null}
      {!corpus.ready && !corpus.error ? <ContentSkeleton label="Loading and syncing your corpus…" /> : null}
      <div className={styles.resultMeta}><span aria-live="polite">{visible.length} items shown</span><span>{selectedKeys.length} selected{hidden ? ` · ${hidden} hidden by filters` : ""}</span></div>
      {corpus.ready && !corpus.records.length ? <div className={styles.empty}><BookOpen size={32} /><h2>Your collection starts with one expression.</h2><p>Save useful language while listening or reading, then find it here.</p><DirectionLink href="/">Find language to save <ArrowRight size={15} /></DirectionLink></div> : corpus.ready && !visible.length ? <div className={styles.empty}><Search size={28} /><h2>No matching items</h2><p>Try a different search or clear your filters.</p><Button variant="secondary" size="inherit" type="button" onClick={() => setFilters(emptyFilters)}>Clear filters</Button></div> : null}
      <div className={`${styles.items} ${view === "list" ? styles.list : ""}`}>
        {visible.map((record) => <article key={record.key} className={`${styles.card} ${selectedKeys.includes(record.key) ? styles.selected : ""}`}>
          <div className={styles.cardTop}><span className={styles.kind} data-kind={record.item.kind}>{record.item.kind}</span><span className={styles.level}>{record.item.level ?? "Unassessed"}</span><input type="checkbox" aria-label={`Select ${expressionText(record)}`} checked={selectedKeys.includes(record.key)} disabled={adding} onChange={() => toggleSelected(record.key)} /></div>
          <button type="button" className={styles.cardBody} aria-label={`View ${expressionText(record)}`} onClick={() => setActive({ key: record.key, edit: false })}><strong className={record.item.kind === "structure" ? styles.structure : ""}>{expressionText(record)}</strong><span>{record.item.meaning || "No meaning saved"}</span></button>
          <div className={styles.tags}>{record.item.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}{record.item.tags.length > 3 ? <span>+{record.item.tags.length - 3}</span> : null}</div>
          <footer className={styles.cardFooter}><span title={record.sourceTitle}>{record.sourceTitle || "Personal corpus"}</span><Button variant="ghost" size="inherit" type="button" className={styles.iconButton} aria-label={`Edit ${expressionText(record)}`} disabled={disabled} onClick={() => setActive({ key: record.key, edit: true })}><Pencil size={14} /></Button></footer>
        </article>)}
      </div>
    </section>
    {selectedKeys.length ? <div className={styles.tray} aria-label="Selected corpus actions"><div><strong>{selectedKeys.length} selected</strong><small>Loadout: up to 3 structures + 5 expressions</small></div><Button variant="secondary" size="inherit" type="button" disabled={adding} onClick={() => { setSelected([]); setMessage(null); }}>Clear selection</Button><DirectionButton variant="primary" type="button" className={styles.primary} disabled={disabled} loading={adding} loadingLabel="Saving…" onClick={() => void addToLoadout()}>Add to Loadout<ArrowRight size={15} /></DirectionButton>{message ? <p role="alert">{message} <Link href="/loadout?returnTo=%2Fcorpus">Open Loadout</Link></p> : null}</div> : null}
    {activeRecord && active ? <CorpusItemDialog key={active.key} record={activeRecord} initialEdit={active.edit} busy={corpus.busy} error={corpus.error} onClose={() => setActive(null)} onUpdate={corpus.update} onRemove={corpus.remove} onHydrate={corpus.hydrate} /> : null}
  </div>;
}
function Facet({ title, values, selected, labels, onToggle }: { title: string; values: readonly string[]; selected: string[]; labels?: Record<string, string>; onToggle(value: string): void }) {
  if (!values.length) return null;
  return <fieldset className={styles.facet}><legend>{title}</legend><div>{values.map((value) => <button type="button" key={value} aria-pressed={selected.includes(value)} onClick={() => onToggle(value)}>{labels?.[value] ?? (value === "unknown" ? "Unassessed" : value)}</button>)}</div></fieldset>;
}
