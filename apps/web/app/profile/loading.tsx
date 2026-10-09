import { ContentSkeleton } from "@/components/ui/ContentSkeleton";
import { BrandLogo } from "@/components/BrandLogo";

export default function Loading() {
  return <main style={{ padding: "24px", maxWidth: 1440, margin: "0 auto" }}><BrandLogo /><ContentSkeleton label="Loading page…" variant="cards" rows={4} /></main>;
}
