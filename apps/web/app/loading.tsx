import { ContentSkeleton } from "@/components/ui/ContentSkeleton";

/** Shared route boundary must not imply a specific learning stage. */
export default function Loading() {
  return <main style={{ padding: 24, maxWidth: 1440, margin: "0 auto" }}><ContentSkeleton label="Loading page…" rows={1} /></main>;
}
