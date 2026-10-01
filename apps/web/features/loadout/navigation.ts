/** Return destinations are local paths, never a second origin or a protocol URL. */
export function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(value)) return "/";
  try {
    const url = new URL(value, "https://libitu.invalid");
    // Query metadata can legitimately include encoded spaces or complete source URLs.
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(decoded)) return "/";
    return url.origin === "https://libitu.invalid" && !url.pathname.startsWith("/loadout") && !url.pathname.startsWith("/speaking/")
      ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch { return "/"; }
}
