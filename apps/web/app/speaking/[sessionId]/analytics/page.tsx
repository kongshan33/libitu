import { readReturnPath } from "@/features/navigation/return-location";
import type { HomeSearchParams } from "@/features/navigation/learning-location";
import type { Metadata } from "next";
import { AnalyticsPage } from "@/features/analytics/AnalyticsPage";
export const metadata: Metadata = { title: "Speaking report · Libitu", description: "Review your mission, language use and evidence-based speaking feedback." };
export default async function Page({ params, searchParams }: { params: Promise<{ sessionId: string }>; searchParams: Promise<HomeSearchParams> }) {
  const [{ sessionId }, query] = await Promise.all([params, searchParams]);
  return <AnalyticsPage sessionId={sessionId} returnTo={readReturnPath(query)} />;
}
