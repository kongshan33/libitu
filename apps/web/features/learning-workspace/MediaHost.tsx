"use client";

import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useLayoutEffect,
  useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { CaptionWordClock } from "../playback/caption-word-clock";
import { YouTubePlayer, type YouTubePlayerHandle, type YouTubePlayerProps } from "../stage-one/components/YouTubePlayer";

type Slot = { element: HTMLDivElement; props: RefObject<YouTubePlayerProps> };
type Media = { setClock(clock: CaptionWordClock | undefined): void; handle: YouTubePlayerHandle; attach(slot: Slot): () => void };
const Context = createContext<Media | null>(null);

/** The iframe stays in this DOM host. Views register geometry and playback ownership only. */
export function MediaHost({ sourceUrl, title, children }: { sourceUrl?: string; title: string; children: ReactNode }) {
  const player = useRef<YouTubePlayerHandle>(null);
  const host = useRef<HTMLDivElement>(null);
  const active = useRef<Slot | null>(null);
  const rates = useRef<number[]>([1]);
  const [clock, setClock] = useState<CaptionWordClock>();
  const [slot, setSlot] = useState<Slot | null>(null);
  const media = useMemo<Media>(() => ({
    setClock,
    handle: {
      seekTo: (...args) => player.current?.seekTo(...args), play: () => player.current?.play(),
      pause: () => player.current?.pause(), setRange: range => player.current?.setRange(range),
      playRange: (...args) => player.current?.playRange(...args), setPlaybackRate: rate => player.current?.setPlaybackRate(rate)
    },
    attach(next) {
      active.current = next; setSlot(next);
      next.props.current.onReady?.(rates.current);
      return () => {
        if (active.current !== next) return;
        player.current?.pause(); player.current?.setRange(null);
        next.props.current.wordClock?.reset();
        active.current = null; setSlot(null);
        if (host.current) host.current.style.visibility = "hidden";
      };
    }
  }), []);

  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    if (!slot || !sourceUrl) { node.style.visibility = "hidden"; return; }
    // Follow layout/scroll without moving the iframe or changing its parent/container.
    const ancestors: HTMLElement[] = [];
    for (let el = slot.element.parentElement; el; el = el.parentElement) ancestors.push(el);
    // Cross-origin iframe wheel events cannot bubble into the slot. A native
    // scroll surface receives browser scroll chaining without covering player controls.
    const reader = slot.element.closest<HTMLElement>(".center-panel");
    const scrollOrigin = 100000;
    let scrollTarget: HTMLElement | null = null;
    function relayScroll() {
      if (!node || !scrollTarget) return;
      const delta = node.scrollTop - scrollOrigin;
      if (!delta) return;
      node.scrollTop = scrollOrigin;
      scrollTarget.scrollTop += delta;
    }
    function position() {
      if (!node || !slot) return;
      const rect = slot.element.getBoundingClientRect();
      let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
      let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
      for (const el of ancestors) {
        const style = getComputedStyle(el), bounds = el.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
      }
      Object.assign(node.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
        visibility: bottom > top && right > left ? "visible" : "hidden",
        clipPath: `inset(${Math.max(0, top - rect.top)}px ${Math.max(0, rect.right - right)}px ${Math.max(0, rect.bottom - bottom)}px ${Math.max(0, left - rect.left)}px)` });
      const nextTarget = reader && /auto|scroll/.test(getComputedStyle(reader).overflowY)
        && reader.scrollHeight > reader.clientHeight ? reader : null;
      if (nextTarget !== scrollTarget) {
        scrollTarget = nextTarget;
        node.dataset.scrollRelay = String(Boolean(scrollTarget));
        node.scrollTop = scrollTarget ? scrollOrigin : 0;
      }
    }
    position();
    node.addEventListener("scroll", relayScroll);
    const resize = new ResizeObserver(position);
    resize.observe(slot.element);
    for (const el of ancestors) resize.observe(el);
    // Streaming rows can create overflow without resizing the fixed-height panel.
    const content = reader ? new MutationObserver(position) : null;
    if (reader) content?.observe(reader, { childList: true, subtree: true });
    window.addEventListener("scroll", position, true); window.addEventListener("resize", position);
    return () => {
      resize.disconnect(); content?.disconnect(); node.removeEventListener("scroll", relayScroll);
      node.dataset.scrollRelay = "false"; node.scrollTop = 0;
      window.removeEventListener("scroll", position, true); window.removeEventListener("resize", position);
    };
  }, [slot, sourceUrl]);

  useEffect(() => {
    const pause = () => { if (document.visibilityState === "hidden") media.handle.pause(); };
    document.addEventListener("visibilitychange", pause);
    return () => { document.removeEventListener("visibilitychange", pause); media.handle.pause(); };
  }, [media]);

  return <Context.Provider value={media}>
    {children}
    <div ref={host} className="workspace-media-host" data-workspace-media-host aria-hidden={!slot}>
      {sourceUrl ? <YouTubePlayer ref={player} sourceUrl={sourceUrl} title={title}
        wordClock={clock}
        onTimeChange={value => active.current?.props.current.onTimeChange(value)}
        onPlaybackChange={value => active.current?.props.current.onPlaybackChange(value)}
        onPlaybackRateChange={value => active.current?.props.current.onPlaybackRateChange?.(value)}
        onReady={value => { rates.current = value; active.current?.props.current.onReady?.(value); }}
        onTelemetry={sample => active.current?.props.current.onTelemetry?.(sample)} /> : null}
      <div className="workspace-media-scroll-space" aria-hidden="true" />
    </div>
  </Context.Provider>;
}

/** Same view contract as YouTubePlayer; standalone callers retain an owned player. */
export const WorkspacePlayer = forwardRef<YouTubePlayerHandle, YouTubePlayerProps>(function WorkspacePlayer(props, ref) {
  const media = useContext(Context);
  return media ? <MediaSlot media={media} playerProps={props} ref={ref} /> : <YouTubePlayer {...props} ref={ref} />;
});
const MediaSlot = forwardRef<YouTubePlayerHandle, { media: Media; playerProps: YouTubePlayerProps }>(function MediaSlot({ media, playerProps }, ref) {
  const element = useRef<HTMLDivElement>(null);
  const props = useRef(playerProps);
  useLayoutEffect(() => { props.current = playerProps; });
  useLayoutEffect(() => { media.setClock(playerProps.wordClock); }, [media, playerProps.wordClock]);
  useImperativeHandle(ref, () => media.handle, [media]);
  useLayoutEffect(() => {
    if (element.current) return media.attach({ element: element.current, props });
  }, [media]);
  return <div ref={element} className="youtube-player-shell workspace-media-slot" aria-hidden="true" />;
});
