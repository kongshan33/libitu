import type { Metadata } from "next";
import { AnalyticsPage } from "@/features/analytics/AnalyticsPage";
export const metadata: Metadata = { title: "Speaking report · Libitu", description: "Review your mission, language use and evidence-based speaking feedback." };
export default async function Page({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return <AnalyticsPage sessionId={sessionId} />;
}
