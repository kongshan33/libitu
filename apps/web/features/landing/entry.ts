import { canonicalVideoSource, learningHref } from "../navigation/learning-location.ts";

export function videoEntryHref(input: string): string | null {
  const value = input.trim();
  if (!value || value.length > 2048) return null;
  const candidate = /^(?:www\.|m\.)?youtube\.com\//i.test(value) || /^youtu\.be\//i.test(value)
    ? `https://${value}` : value;
  try {
    const url = new URL(candidate);
    if (url.port) return null;
    const sourceUrl = canonicalVideoSource(candidate);
    if (!sourceUrl) return null;
    // Do not infer language or propagate tracking/redirect parameters from a paste.
    return learningHref({ sourceUrl });
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
