import type { Metadata } from "next";
import { SessionPreparation } from "@/features/loadout/components/SessionPreparation";

export const metadata: Metadata = { title: "Your mission · Libitu", description: "Review your saved speaking mission and selected language." };

export default async function Page({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return <SessionPreparation sessionId={sessionId} />;
}
