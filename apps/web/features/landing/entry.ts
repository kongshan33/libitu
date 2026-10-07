import { captionVideoId } from "../stage-one/api/fresh-captions.ts";

export type HomeSearchParams = Record<string, string | string[] | undefined>;

/** Marketing/auth parameters alone must never start a demo processing job. */
export function hasReaderSource(params: HomeSearchParams): boolean {
  return ["sourceUrl", "contentId", "jobId", "handoffId"].some((key) => {
    const value = params[key];
    return (Array.isArray(value) ? value : [value]).some((part) => Boolean(part?.trim()));
  });
}

export function videoEntryHref(input: string): string | null {
  const value = input.trim();
  if (!value || value.length > 2048) return null;
  const candidate = /^(?:www\.|m\.)?youtube\.com\//i.test(value) || /^youtu\.be\//i.test(value)
    ? `https://${value}` : value;
  try {
    const url = new URL(candidate);
    if (url.port) return null;
    const videoId = captionVideoId(candidate);
    if (!videoId) return null;
    // Do not infer language or propagate tracking/redirect parameters from a paste.
    return `/?${new URLSearchParams({ sourceUrl: `https://www.youtube.com/watch?v=${videoId}` })}`;
  } catch { return null; }
}

export function chromeStoreHref(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "chromewebstore.google.com"
      && !url.port && !url.username && !url.password && /^\/detail\/[^/]+\/[a-p]{32}\/?$/.test(url.pathname)
      ? url.href : null;
  } catch { return null; }
}
