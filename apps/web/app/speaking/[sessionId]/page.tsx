import { readReturnPath } from "@/features/navigation/return-location";
import type { HomeSearchParams } from "@/features/navigation/learning-location";
import type { Metadata } from "next";
import { ConversationWorkspace } from "@/features/speaking/ConversationWorkspace";

export const metadata: Metadata = { title: "Conversation · Libitu", description: "Practice your selected language in a speaking mission." };

export default async function Page({ params, searchParams }: { params: Promise<{ sessionId: string }>; searchParams: Promise<HomeSearchParams> }) {
  const [{ sessionId }, query] = await Promise.all([params, searchParams]);
  return <ConversationWorkspace sessionId={sessionId} returnTo={readReturnPath(query)} />;
}
