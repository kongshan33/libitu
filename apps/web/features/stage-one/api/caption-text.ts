/** Remove caption cues from cached and fresh transcript text before annotation. */
export function cleanCaptionText(text: string): string {
  return text
    .replace(/\[[^\[\]\r\n]*\]|[<>]{2,}|[\[\]]/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
