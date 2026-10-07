"use client";
import { useEffect, useState } from "react";
import { createConversationApi } from "./api";
import { ConversationController, initialConversationState } from "./controller";

export function useConversation(owner: string, sessionId: string, getToken: () => Promise<string | null>) {
  const [state, setState] = useState(initialConversationState);
  const [controller, setController] = useState<ConversationController | null>(null);
  useEffect(() => {
    const current = new ConversationController(owner, sessionId, createConversationApi(owner, sessionId, getToken), setState);
    setController(current); void current.load();
    const hide = () => { if (document.hidden) current.pause(); };
    const pagehide = () => current.pause();
    const beforeUnload = (event: BeforeUnloadEvent) => { if (current.state.pending) event.preventDefault(); };
    document.addEventListener("visibilitychange", hide); window.addEventListener("pagehide", pagehide); window.addEventListener("beforeunload", beforeUnload);
    return () => { document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", pagehide); window.removeEventListener("beforeunload", beforeUnload); current.dispose(); };
  }, [owner, sessionId, getToken]);
  return { state, controller };
}
