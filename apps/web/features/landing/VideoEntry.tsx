"use client";

import { DirectionButton } from "@/components/ui/direction-button";

import { Input } from "@/components/ui/field";


import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Link2 } from "lucide-react";
import { videoEntryHref } from "./entry";
import styles from "./LandingPage.module.css";

const DRAFT_KEY = "libitu:landing-video:v1";

export function VideoEntry() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    try { setValue(sessionStorage.getItem(DRAFT_KEY)?.slice(0, 2048) ?? ""); } catch { /* Storage may be disabled. */ }
  }, []);

  function changeValue(next: string) {
    setValue(next);
    setError(null);
    // Same-tab draft survives an OAuth redirect, without storing account data.
    try { sessionStorage.setItem(DRAFT_KEY, next); } catch { /* Input remains usable. */ }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const href = videoEntryHref(value);
    if (!href) {
      setError(value.trim() ? "Enter a YouTube video link, such as https://www.youtube.com/watch?v=abcdefghijk."
        : "Paste a YouTube video link to get started.");
      input.current?.focus();
      return;
    }
    startTransition(() => router.push(href));
  }

  return <form className={styles.entryForm} onSubmit={submit} noValidate aria-busy={pending}>
    {/* <label className={styles.inputLabel} htmlFor="video-url">Your YouTube video</label> */}
    <div className={styles.entryRow}>
      <div className={`ui-field-surface ${styles.inputWrap}`} data-field-surface>
        <Link2 size={19} aria-hidden="true" />
        <Input appearance="bare" ref={input} id="video-url" name="videoUrl" type="url" inputMode="url" autoComplete="off"
          spellCheck={false} autoCapitalize="none" maxLength={2048} placeholder="Paste a YouTube video link…"
          value={value} onChange={(event) => changeValue(event.target.value)}
          aria-invalid={Boolean(error)} aria-describedby={`video-help${error ? " video-error" : ""}`} />
      </div>
      <DirectionButton variant="primary" className={styles.primaryButton} type="submit" loading={pending} loadingLabel="Opening video…">
        Analyze video<ArrowRight size={17} aria-hidden="true" />
      </DirectionButton>
    </div>
    <p id="video-error" className={styles.error} role="alert">{error}</p>
    {/* <p id="video-help" className={styles.entryHelp}>No sign-in required · English videos with available captions</p> */}
    <span className={styles.srOnly} role="status">{pending ? "Opening your video workspace." : ""}</span>
  </form>;
}
