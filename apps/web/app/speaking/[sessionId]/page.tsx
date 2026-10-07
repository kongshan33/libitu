import type { Metadata } from "next";
import { ConversationWorkspace } from "@/features/speaking/ConversationWorkspace";

export const metadata: Metadata = { title: "Conversation · Libitu", description: "Practice your selected language in a speaking mission." };

export default async function Page({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return <ConversationWorkspace sessionId={sessionId} />;
}
