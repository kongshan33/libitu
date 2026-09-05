"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

type YouTubePlayerInstance = {
  destroy(): void;
  getCurrentTime(): number;
  playVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
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

export type YouTubePlayerHandle = {
  seekTo(seconds: number): void;
};

type YouTubePlayerProps = {
  sourceUrl: string;
  title: string;
  onTimeChange(time: number): void;
};

let apiPromise: Promise<YouTubeApi> | null = null;

export const YouTubePlayer = forwardRef<YouTubePlayerHandle, YouTubePlayerProps>(function YouTubePlayer(
  { sourceUrl, title, onTimeChange },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const onTimeChangeRef = useRef(onTimeChange);
  const titleRef = useRef(title);
  const [origin, setOrigin] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const videoId = getYouTubeVideoId(sourceUrl);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    onTimeChangeRef.current = onTimeChange;
    titleRef.current = title;
    const iframe = containerRef.current?.querySelector("iframe");
    if (iframe) iframe.title = `${title} on YouTube`;
  }, [onTimeChange, title]);

  useImperativeHandle(ref, () => ({
    seekTo(seconds: number) {
      const player = playerRef.current;
      if (!player) {
        pendingSeekRef.current = seconds;
        return;
      }
      player.seekTo(seconds, true);
      player.playVideo();
      onTimeChangeRef.current(seconds);
    }
  }), []);

  useEffect(() => {
    const container = containerRef.current;
    if (!videoId || !origin || !container) return;

    let disposed = false;
    let intervalId: number | null = null;
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
          onError: (event) => setPlayerError(youtubeErrorMessage(event.data)),
          onReady: () => {
            const pendingSeek = pendingSeekRef.current;
            if (pendingSeek !== null && playerRef.current) {
              playerRef.current.seekTo(pendingSeek, true);
              playerRef.current.playVideo();
              pendingSeekRef.current = null;
            }
            intervalId = window.setInterval(() => {
              const player = playerRef.current;
              if (!player) return;
              const currentTime = player.getCurrentTime();
              if (Number.isFinite(currentTime)) onTimeChangeRef.current(currentTime);
            }, 500);
          }
        }
      });
    });

    return () => {
      disposed = true;
      if (intervalId !== null) window.clearInterval(intervalId);
      playerRef.current?.destroy();
      playerRef.current = null;
      container.replaceChildren();
    };
  }, [origin, videoId]);

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
