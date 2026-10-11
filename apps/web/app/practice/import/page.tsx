import { ContentImport } from "@/features/content-entry/ContentImport";
import { parseLearningLocation, searchParamsFromRecord, type HomeSearchParams } from "@/features/navigation/learning-location";
export default async function ImportPage({ searchParams }: { searchParams: Promise<HomeSearchParams> }) {
  const location = parseLearningLocation(new URL("/practice/import?" + searchParamsFromRecord(await searchParams), "https://libitu.invalid"));
  return <ContentImport location={location} />;
}
