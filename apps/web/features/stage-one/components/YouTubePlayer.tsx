"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { YouTubePlaybackController, type YouTubeTransport, type YouTubePlayerHandle } from "../../playback/youtube-controller";
import type { CaptionWordClock } from "../../playback/caption-word-clock";
export type { YouTubePlayerHandle } from "../../playback/youtube-controller";

export type YouTubeTelemetry = {
  time: number; state: number; rate: number; wallTime: number; epochTime?: number;
  blockedByPausedSeek?: boolean;
};

type YouTubePlayerInstance = YouTubeTransport & {
  destroy(): void;
  getPlaybackRate(): number;
  getAvailablePlaybackRates(): number[];
  getPlayerState?(): number;
};

type YouTubePlayerEvent = {
  data: number;
};

type YouTubeApi = {
  Player: new (
    element: HTMLIFrameElement,
    options: {
      events: {
        onError: (event: YouTubePlayerEvent) => void;
        onReady: () => void;
        onStateChange: (event: YouTubePlayerEvent) => void;
        onPlaybackRateChange: (event: YouTubePlayerEvent) => void;
        onAutoplayBlocked: () => void;
      };
    }
  ) => YouTubePlayerInstance;
};

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

type YouTubePlayerProps = {
  sourceUrl: string;
  title: string;
  onPlaybackChange(isPlaying: boolean): void;
  onTimeChange(time: number): void;
  onReady?(rates: number[]): void;
  onPlaybackRateChange?(rate: number): void;
  onTelemetry?(sample: YouTubeTelemetry): void;
  wordClock?: CaptionWordClock;
};

let apiPromise: Promise<YouTubeApi> | null = null;

export const YouTubePlayer = forwardRef<YouTubePlayerHandle, YouTubePlayerProps>(function YouTubePlayer(
  { sourceUrl, title, onPlaybackChange, onTimeChange, onReady, onPlaybackRateChange, onTelemetry, wordClock },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const onPlaybackChangeRef = useRef(onPlaybackChange);
  const onTimeChangeRef = useRef(onTimeChange);
  const onReadyRef = useRef(onReady);
  const onRateChangeRef = useRef(onPlaybackRateChange);
  const onTelemetryRef = useRef(onTelemetry);
  const wordClockRef = useRef(wordClock);
  const titleRef = useRef(title);
  const [origin, setOrigin] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [controller] = useState(() => new YouTubePlaybackController({
    time: (seconds) => onTimeChangeRef.current(seconds),
    playback: (playing) => onPlaybackChangeRef.current(playing),
    error: setPlayerError
  }));
  const videoId = getYouTubeVideoId(sourceUrl);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    onPlaybackChangeRef.current = onPlaybackChange;
    onTimeChangeRef.current = onTimeChange;
    onReadyRef.current = onReady;
    onRateChangeRef.current = onPlaybackRateChange;
    onTelemetryRef.current = onTelemetry;
    wordClockRef.current = wordClock;
    titleRef.current = title;
    const iframe = containerRef.current?.querySelector("iframe");
    if (iframe) iframe.title = `${title} on YouTube`;
  }, [onPlaybackChange, onTimeChange, title, onReady, onPlaybackRateChange, onTelemetry, wordClock]);

  useImperativeHandle(ref, () => controller, [controller]);

  useEffect(() => {
    const container = containerRef.current;
    if (!videoId || !origin || !container) return;

    let disposed = false;
    let intervalId: number | null = null;
    let nativeState = -1;
    let stateRevision = 0;
    let coarseSampleAt = -Infinity;
    function reportWordTime() {
      const player = playerRef.current;
      if (!player || disposed) return;
      wordClockRef.current?.publish(player.getCurrentTime(), document.visibilityState !== "hidden"
        && (player.getPlayerState?.() ?? nativeState) === 1 && !controller.isSeekPending());
    }
    function visibilityChanged() {
      if (document.visibilityState === "hidden") wordClockRef.current?.reset();
      else reportWordTime();
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    function reportTelemetry(overrides?: { state?: number; rate?: number }) {
      const player = playerRef.current;
      if (!player || disposed || !onTelemetryRef.current) return;
      onTelemetryRef.current({ time: player.getCurrentTime(), state: overrides?.state ?? player.getPlayerState?.() ?? nativeState,
        rate: overrides?.rate ?? player.getPlaybackRate(), wallTime: performance.now(), epochTime: Date.now(),
        blockedByPausedSeek: controller.isPausedSeekPending() });
    }
    const iframe = document.createElement("iframe");
    iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    iframe.allowFullscreen = true;
    iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?enablejsapi=1&playsinline=1&origin=${encodeURIComponent(origin)}`;
    iframe.title = `${titleRef.current} on YouTube`;
    container.replaceChildren(iframe);
    setPlayerError(null);

    loadYouTubeApi().then((api) => {
      if (disposed) return;

      playerRef.current = new api.Player(iframe, {
        events: {
          onError: (event) => {
            if (disposed) return;
            nativeState = -1;
            reportTelemetry({ state: -1 });
            controller.pause();
            wordClockRef.current?.reset();
            setPlayerError(youtubeErrorMessage(event.data));
          },
          onReady: () => {
            if (disposed || !playerRef.current) return;
            controller.attach(playerRef.current);
            onReadyRef.current?.(playerRef.current.getAvailablePlaybackRates());
            onRateChangeRef.current?.(playerRef.current.getPlaybackRate());
            intervalId = window.setInterval(() => {
              const player = playerRef.current;
              if (!player) return;
              const now = performance.now();
              if (now - coarseSampleAt >= 95) {
                coarseSampleAt = now;
                // Capture observes the unmodified clock before range completion pauses/seeks it.
                reportTelemetry();
                controller.sample(player.getCurrentTime());
              }
              // Caption highlighting uses actual provider time, never wall-time interpolation.
              reportWordTime();
            }, 50);
          },
          onStateChange: (event) => {
            if (disposed) return;
            nativeState = event.data;
            const revision = ++stateRevision;
            reportTelemetry({ state: event.data });
            // A capture guard can synchronously pause from the telemetry callback.
            if (revision !== stateRevision) return;
            if (event.data === 1) setPlayerError(null);
            controller.onStateChange(event.data);
            reportWordTime();
          },
          onPlaybackRateChange: (event) => {
            if (!disposed) {
              reportTelemetry({ rate: event.data });
              onRateChangeRef.current?.(event.data);
              reportWordTime();
            }
          },
          onAutoplayBlocked: () => {
            if (disposed) return;
            controller.pause();
            setPlayerError("Playback was blocked. Press play in the video to continue.");
          }
        }
      });
    });

    return () => {
      disposed = true;
      if (intervalId !== null) window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", visibilityChanged);
      wordClockRef.current?.reset();
      controller.detach();
      playerRef.current?.destroy();
      playerRef.current = null;
      container.replaceChildren();
    };
  }, [controller, origin, videoId]);

  if (!videoId) return <p className="empty-state">The source video URL is unavailable.</p>;
  if (!origin) return null;

  return (
    <div className="youtube-player-shell">
      <div className="youtube-player" ref={containerRef} />
      {playerError ? <p className="video-player-error" role="alert">{playerError}</p> : null}
    </div>
  );
});

function youtubeErrorMessage(code: number) {
  if (code === 2) return "This YouTube video ID is invalid.";
  if (code === 5) return "YouTube could not play this video in HTML5.";
  if (code === 100) return "This YouTube video is unavailable.";
  if (code === 101 || code === 150) return "The video owner does not allow embedded playback.";
  return "YouTube could not start the embedded player.";
}

function loadYouTubeApi(): Promise<YouTubeApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve) => {
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousCallback?.();
      if (window.YT) resolve(window.YT);
    };

    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      document.head.appendChild(script);
    }
  });

  return apiPromise;
}

function getYouTubeVideoId(sourceUrl: string): string | null {
  try {
    const url = new URL(sourceUrl);
    if (url.hostname.endsWith("youtu.be")) return url.pathname.slice(1) || null;
    if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || null;
    return url.searchParams.get("v");
  } catch {
    return null;
  }
}
