import { StageOneReader } from "@/features/stage-one/components/StageOneReader";
import { LandingPage } from "@/features/landing/LandingPage";
import { hasReaderSource, type HomeSearchParams } from "@/features/landing/entry";

export default async function Home({ searchParams }: { searchParams: Promise<HomeSearchParams> }) {
  const params = await searchParams;
  return hasReaderSource(params) ? <StageOneReader /> : <LandingPage />;
}
