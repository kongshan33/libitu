import type { Metadata } from "next";
import { ProfilePage } from "@/features/profile/ProfilePage";

export const metadata: Metadata = { title: "Practice history · Libitu" };
export default async function Page({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind } = await searchParams;
  const historyKind = kind === "video" || kind === "shadowing" || kind === "speaking" ? kind : "all";
  return <ProfilePage history historyKind={historyKind} />;
}
