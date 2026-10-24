import type { SpeakingClientEvent, SpeakingHelpLevel, SpeakingServerEvent, SpeakingSupportLevel, SpeakingWorkspace } from "@libitu/types/speaking";
import { ConversationApiError, runtimeSocketUrl, type ConversationApi } from "./api.ts";
import { ConversationAudio } from "./audio.ts";
import { currentSupport, isSupportLevel } from "./support.ts";

export type ConnectionState = "loading" | "idle" | "connecting" | "connected" | "disconnected" | "paused" | "ended" | "error";
export type ConversationState = {
  workspace: SpeakingWorkspace | null; connection: ConnectionState; phase: "listening" | "thinking" | "speaking";
  microphone: boolean; microphoneBusy: boolean; userSpeaking: boolean; error: string | null; conflict: boolean; busy: boolean;
  partials: Record<string, { role: "user" | "assistant"; text: string }>;
  pending: { id: string; text: string; status: "sending" | "unconfirmed" } | null;
  supportPending: { requestId: string; level: SpeakingSupportLevel; expectedVersion: number } | null;
  supportError: string | null;
};
export const initialConversationState = (): ConversationState => ({ workspace: null, connection: "loading", phase: "listening", microphone: false, microphoneBusy: false, userSpeaking: false, error: null, conflict: false, busy: false, partials: {}, pending: null, supportPending: null, supportError: null });
type AudioPort = Pick<ConversationAudio, "prepare" | "enableMicrophone" | "disableMicrophone" | "append" | "report" | "clear" | "dispose">;
type Dependencies = {
  socket?: (url: string) => WebSocket;
  socketUrl?: (path: string) => string;
  audio?: (frame: (audio: string) => void, boundary: (item: string, ms: number) => void, lost: () => void) => AudioPort;
  uuid?: () => string;
};
export class ConversationController {
  state = initialConversationState();
  private disposed = false;
  private epoch = 0;
  private abort = new AbortController();
  private socket: WebSocket | null = null;
  private audio: AudioPort | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private boundary: ReturnType<typeof setInterval> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private acknowledgementTimer: ReturnType<typeof setTimeout> | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private supportTimer: ReturnType<typeof setTimeout> | null = null;
  private unconfirmedSupport: ConversationState["supportPending"] = null;
  private hintRequest: string | null = null;
  private retiredHints = new Set<string>();
  private shownHints = new Set<string>();
  private shownMessages = new Set<string>();
  private shownTargets = new Set<string>();
  private visibleTargets = new Set<string>();
  private lastPong = 0;
  private connecting: Promise<boolean> | null = null;
  private finishConnection: ((value: boolean) => void) | null = null;
  private playingResponse: string | null = null;
  private suppressedResponses = new Set<string>();
  private awaitingAudioClear = false;
  constructor(private readonly owner: string, private readonly sessionId: string, private readonly api: ConversationApi, private readonly changed: (state: ConversationState) => void, private readonly dependencies: Dependencies = {}) {}
  private patch(patch: Partial<ConversationState>): void { if (this.disposed) return; this.state = { ...this.state, ...patch }; this.changed(this.state); }
  private uuid(): string { return this.dependencies.uuid?.() ?? crypto.randomUUID(); }
  private current(epoch: number): boolean { return !this.disposed && epoch === this.epoch; }
  private accept(workspace: SpeakingWorkspace): boolean {
    if (workspace.session.user_id !== this.owner || workspace.session.id !== this.sessionId || !Number.isSafeInteger(workspace.version)) return false;
    if (this.state.workspace && workspace.version < this.state.workspace.version) return false;
    const previousSupport = this.state.workspace ? currentSupport(this.state.workspace) : null;
    let support = currentSupport(workspace);
    if (previousSupport && (!support || support.version < previousSupport.version)) {
      workspace = { ...workspace, support: previousSupport };
      support = previousSupport;
    }
    const supportChanged = !!this.state.workspace && (support?.level !== previousSupport?.level || support?.version !== previousSupport?.version);
    let previousHelp = this.state.workspace?.help;
    let incomingHelp = workspace.help;
    if (supportChanged) {
      if (previousHelp) this.retiredHints.add(previousHelp.id);
      if (this.hintRequest) this.retiredHints.add(this.hintRequest);
      this.hintRequest = null;
      if (this.hintTimer) clearTimeout(this.hintTimer);
      this.hintTimer = null;
      previousHelp = null;
    }
    if (support && incomingHelp?.source === "automatic") {
      this.retiredHints.add(incomingHelp.id);
      incomingHelp = null;
      workspace = { ...workspace, help: null };
    }
    const skipped = new Set(workspace.opportunities?.filter(value => value.status === "skipped").map(value => value.session_item_id));
    // A confirmed skip cancels this target's help, including a request whose
    // provider result is still in flight. Do not revive it as a stale snapshot.
    if (previousHelp?.target_item_id && skipped.has(previousHelp.target_item_id)) {
      this.retiredHints.add(previousHelp.id);
      if (this.hintRequest === previousHelp.id) {
        this.hintRequest = null;
        if (this.hintTimer) clearTimeout(this.hintTimer);
        this.hintTimer = null;
      }
      previousHelp = null;
    }
    if (incomingHelp?.target_item_id && skipped.has(incomingHelp.target_item_id)) {
      this.retiredHints.add(incomingHelp.id);
      incomingHelp = null;
      workspace = { ...workspace, help: null };
    }
    // A late hint result must not replace a newer request, even if another
    // runtime mutation has advanced the enclosing snapshot version.
    if ((this.hintRequest && incomingHelp?.id !== this.hintRequest)
      || (incomingHelp && this.retiredHints.has(incomingHelp.id))
      || (incomingHelp && previousHelp?.id === incomingHelp.id && incomingHelp.version < previousHelp.version)) {
      workspace = { ...workspace, help: previousHelp ?? null };
    } else if (incomingHelp?.id === this.hintRequest && incomingHelp?.status !== "loading") {
      this.hintRequest = null;
      if (this.hintTimer) clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    const finalized = new Set(workspace.messages.filter(message => message.status !== "unavailable").map(message => message.provider_item_id).filter(Boolean));
    const partials = Object.fromEntries(Object.entries(this.state.partials).filter(([id]) => !finalized.has(id)));
    const pending = this.state.pending && !workspace.messages.some(message => message.client_turn_id === this.state.pending?.id) ? this.state.pending : null;
    if (!pending && this.acknowledgementTimer) { clearTimeout(this.acknowledgementTimer); this.acknowledgementTimer = null; }
    const supportRequest = this.state.supportPending ?? this.unconfirmedSupport;
    const supportConfirmed = !!supportRequest && !!support && support.version > supportRequest.expectedVersion;
    if (supportConfirmed) {
      if (this.supportTimer) clearTimeout(this.supportTimer);
      this.supportTimer = null; this.unconfirmedSupport = null;
    }
    this.patch({ workspace, partials, pending, ...(supportConfirmed ? {
      supportPending: null,
      supportError: support?.level === supportRequest?.level ? null : "Support changed elsewhere. Review the current level before choosing again."
    } : {}) }); return true;
  }
  async load(): Promise<void> {
    const epoch = this.epoch;
    this.patch({ connection: "loading", error: null });
    try {
      const workspace = await this.api.read(this.abort.signal);
      if (!this.current(epoch)) return;
      if (!this.accept(workspace)) throw new Error("The mission could not be verified for this account.");
      this.patch({ connection: ["completed", "abandoned"].includes(workspace.session.status) ? "ended" : "idle" });
    } catch (error) { if (this.current(epoch)) this.patch({ connection: "error", error: this.message(error) }); }
  }
  private message(error: unknown): string { return error instanceof Error ? error.message : "The conversation could not continue. Please retry."; }
  private send(event: SpeakingClientEvent): boolean {
    if (!this.socket || this.socket.readyState !== 1 || this.disposed) return false;
    if (event.type !== "authenticate" && this.state.connection !== "connected") return false;
    if (this.socket.bufferedAmount > 256_000) { this.disconnect("Your connection fell behind. Reconnect to continue."); return false; }
    try { this.socket.send(JSON.stringify(event)); return true; } catch { this.disconnect("Connection interrupted. Reconnect to continue."); return false; }
  }
  private getAudio(): AudioPort {
    if (!this.audio) {
      const create = this.dependencies.audio ?? ((frame, boundary, lost) => new ConversationAudio(frame, boundary, lost));
      this.audio = create(audio => { if (this.state.microphone) this.send({ type: "audio.append", audio }); }, (item_id, played_ms) => this.send({ type: "playback", item_id, played_ms }), () => {
        this.send({ type: "microphone", enabled: false }); this.patch({ microphone: false, error: "The microphone stopped. Enable it again or keep typing." });
      });
    }
    return this.audio;
  }
  start(voice: boolean, takeover = false): Promise<boolean> {
    if (this.disposed || this.state.connection === "ended" || !this.state.workspace) return Promise.resolve(false);
    if (this.state.connection === "connected") return voice ? this.setMicrophone(true).then(() => true) : Promise.resolve(true);
    if (this.connecting) return this.connecting;
    this.connecting = this.connect(voice, takeover).finally(() => { this.connecting = null; });
    return this.connecting;
  }
  private async connect(voice: boolean, takeover: boolean): Promise<boolean> {
    this.closeRuntime();
    const epoch = this.epoch;
    this.patch({ connection: "connecting", error: null, conflict: false, partials: {}, microphoneBusy: voice });
    let microphone = false;
    let microphoneSettled = !voice;
    // prepare() is entered directly from the user's action, before HTTP or socket awaits.
    const audio = voice ? this.getAudio() : null;
    if (audio) void audio.enableMicrophone().then(() => {
      microphone = true;
    }).catch(() => {
      if (this.current(epoch)) this.patch({ error: "Microphone unavailable or permission denied. You can continue by typing." });
    }).finally(() => {
      microphoneSettled = true;
      if (!this.current(epoch)) return;
      if (this.state.connection === "connected" && !this.send({ type: "microphone", enabled: microphone })) return;
      if (this.current(epoch)) this.patch({ microphoneBusy: false, microphone: this.state.connection === "connected" && microphone });
    });
    try {
      const ticket = await this.api.connect(this.uuid(), takeover, this.abort.signal);
      if (!this.current(epoch)) return false;
      const socket = (this.dependencies.socket ?? (url => new WebSocket(url)))((this.dependencies.socketUrl ?? runtimeSocketUrl)(ticket.websocket_path));
      this.socket = socket;
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean) => { if (!settled) { settled = true; resolve(value); } };
        this.finishConnection = finish;
        this.readyTimer = setTimeout(() => { if (this.current(epoch)) this.disconnect("Connection timed out. Please reconnect."); finish(false); }, 30_000);
        socket.onopen = () => { if (this.current(epoch)) this.send({ type: "authenticate", ticket: ticket.ticket }); };
        socket.onmessage = event => {
          if (!this.current(epoch) || typeof event.data !== "string" || event.data.length > 1_200_000) return;
          let message: SpeakingServerEvent;
          try { message = JSON.parse(event.data) as SpeakingServerEvent; } catch { return; }
          if (message.type === "ready") {
            if (!this.accept(message.workspace)) { this.disconnect("The mission connection could not be verified."); finish(false); return; }
            if (this.readyTimer) clearTimeout(this.readyTimer); this.readyTimer = null;
            this.lastPong = Date.now();
            this.patch({ connection: "connected", phase: "listening", microphone, microphoneBusy: !microphoneSettled });
            // Wording can be viewed before connecting. Deliver those actual
            // exposures before the first text turn is allowed to submit.
            for (const id of this.visibleTargets) this.targetShown(id);
            if (!this.current(epoch)) { finish(false); return; }
            // Defer the opening until voice permission settles, without blocking
            // ready/text input on the browser's permission dialog.
            if ((microphoneSettled && !this.send({ type: "microphone", enabled: microphone })) || !this.current(epoch)) { finish(false); return; }
            this.heartbeat = setInterval(() => { if (Date.now() - this.lastPong > 35_000) this.disconnect("Connection lost. Your saved transcript is safe."); else this.send({ type: "ping" }); }, 10_000);
            this.boundary = setInterval(() => this.audio?.report(), 250);
            finish(true); return;
          }
          this.receive(message);
        };
        socket.onerror = () => { if (this.current(epoch)) this.disconnect("Could not connect. Please reconnect when ready."); finish(false); };
        socket.onclose = () => { if (this.current(epoch) && this.state.connection !== "ended") this.disconnect("Connection closed. Reconnect to continue from the saved transcript."); finish(false); };
      });
    } catch (error) {
      if (this.current(epoch)) { this.closeRuntime(); this.patch({ connection: "disconnected", microphone: false, microphoneBusy: false, conflict: error instanceof ConversationApiError && error.status === 409, error: this.message(error) }); }
      return false;
    }
  }
  private receive(event: SpeakingServerEvent): void {
    if (event.type === "snapshot") {
      if (this.accept(event.workspace) && ["completed", "abandoned"].includes(event.workspace.session.status)) { this.closeRuntime(); this.patch({ connection: "ended", microphone: false, microphoneBusy: false, partials: {}, pending: null }); }
      return;
    }
    if (event.type === "ended") { if (this.accept(event.workspace)) { this.closeRuntime(); this.patch({ connection: "ended", microphone: false, microphoneBusy: false, partials: {}, pending: null }); } return; }
    if (event.type === "pong") { this.lastPong = Date.now(); return; }
    if (event.type === "state") { if (["listening", "thinking", "speaking"].includes(event.state)) this.patch({ phase: event.state }); return; }
    if (event.type === "user.activity") {
      if (typeof event.speaking === "boolean") {
        if (event.speaking) this.retireAutomaticHint();
        this.patch({ userSpeaking: event.speaking });
      }
      return;
    }
    if (event.type === "transcript.delta") {
      const previous = this.state.partials[event.item_id]?.text ?? "";
      if (typeof event.delta !== "string" || previous.length + event.delta.length > 12_000 || Object.keys(this.state.partials).length > 5) return;
      if (event.role === "user" && event.delta.trim()) this.retireAutomaticHint();
      this.patch({ partials: { ...this.state.partials, [event.item_id]: { role: event.role, text: previous + event.delta } } }); return;
    }
    if (event.type === "audio.delta") {
      if (this.awaitingAudioClear || this.suppressedResponses.has(event.response_id)) return;
      this.playingResponse = event.response_id;
      try { this.audio?.append(event.item_id, event.audio); } catch (error) { this.disconnect(this.message(error)); }
      return;
    }
    if (event.type === "audio.clear") { this.clearPlayback(); this.awaitingAudioClear = false; return; }
    if (event.type === "error") {
      if (event.code === "support_changed" || event.code === "support_busy") {
        if (!this.state.supportPending || event.request_id && event.request_id !== this.state.supportPending.requestId) return;
        if (this.supportTimer) clearTimeout(this.supportTimer);
        this.supportTimer = null; this.unconfirmedSupport = null;
        this.patch({ supportPending: null, supportError: event.code === "support_busy"
          ? "Wait for the current reply to finish, then choose support again."
          : "Support changed elsewhere. Review the current level before choosing again." });
        return;
      }
      this.patch({ error: event.message.slice(0, 300), pending: this.state.pending ? { ...this.state.pending, status: "unconfirmed" } : null }); if (!event.retryable) this.disconnect(event.message.slice(0, 300));
    }
  }
  async setMicrophone(enabled: boolean): Promise<void> {
    if (this.state.connection !== "connected" || this.state.microphoneBusy) return;
    if (!enabled) { this.audio?.disableMicrophone(); this.awaitingAudioClear = true; this.clearPlayback(); this.send({ type: "microphone", enabled: false }); this.patch({ microphone: false }); return; }
    const epoch = this.epoch; this.patch({ microphoneBusy: true, error: null });
    try { await this.getAudio().enableMicrophone(); if (this.current(epoch) && this.send({ type: "microphone", enabled: true })) this.patch({ microphone: true, microphoneBusy: false }); }
    catch { if (this.current(epoch)) this.patch({ microphone: false, microphoneBusy: false, error: "Microphone unavailable or permission denied. You can keep typing." }); }
  }
  async submit(text: string): Promise<boolean> {
    text = text.trim(); if (!text || text.length > 4000 || this.state.pending || this.state.connection === "ended") return false;
    this.retireAutomaticHint();
    const pending = { id: this.uuid(), text, status: "sending" as const }; this.patch({ pending });
    if (this.state.connection !== "connected" && !await this.start(false)) {
      if (this.isPending(pending.id)) this.patch({ pending: { ...pending, status: "unconfirmed" } });
      return false;
    }
    if (!this.isPending(pending.id)) return false;
    if (!this.send({ type: "text.submit", client_turn_id: pending.id, text })) { this.patch({ pending: { ...pending, status: "unconfirmed" } }); return false; }
    this.awaitAcknowledgement(pending.id);
    return true;
  }
  private isPending(id: string): boolean { return !this.disposed && this.state.pending?.id === id && this.state.connection !== "ended"; }
  async retryText(): Promise<void> {
    const pending = this.state.pending; if (!pending) return;
    if (this.state.connection !== "connected" && !await this.start(false)) return;
    // ready may acknowledge a message whose first response was lost.
    if (!this.state.pending) return;
    this.patch({ pending: { ...pending, status: "sending" } });
    this.send({ type: "text.submit", client_turn_id: pending.id, text: pending.text });
    this.awaitAcknowledgement(pending.id);
  }
  private awaitAcknowledgement(id: string): void {
    if (this.acknowledgementTimer) clearTimeout(this.acknowledgementTimer);
    this.acknowledgementTimer = setTimeout(() => { if (this.state.pending?.id === id) this.patch({ pending: { ...this.state.pending, status: "unconfirmed" }, error: "Your message is not confirmed yet. Retry the same message to check safely." }); }, 20_000);
  }
  hint(level: "usage" | "example" = "usage", targetItemId?: string): void {
    const workspace = this.state.workspace;
    if (!workspace || this.state.connection !== "connected") return;
    if (!targetItemId && workspace.session.mission_plan && workspace.opportunities?.length && workspace.opportunities.every(value => value.status === "skipped")) return;
    const target = targetItemId ? workspace.session.items.find(item => item.id === targetItemId) : workspace.session.items.find(item => item.id === workspace.help?.target_item_id);
    if (targetItemId && !target) return;
    if (target && workspace.opportunities?.some(value => value.session_item_id === target.id && value.status === "skipped")) return;
    if (this.hintRequest === workspace.help?.id && workspace.help?.status === "loading" && workspace.help.level === level && workspace.help.target_item_id === (target?.id ?? null)) return;
    const id = this.uuid();
    if (!this.send({ type: "hint", request_id: id, level, ...(target?.id ? { target_item_id: target.id } : {}) })) return;
    if (workspace.help) this.retiredHints.add(workspace.help.id);
    this.hintRequest = id;
    if (this.hintTimer) clearTimeout(this.hintTimer);
    // The server confirms version 1 before any language is exposed or logged.
    this.patch({ workspace: { ...workspace, help: { id, version: 0, target_item_id: target?.id ?? null, level, status: "loading", direction: null, expression: null, meaning: null, pattern: null, example: null, substitution: null, source: "requested", source_message_id: null, error: null } } });
    this.hintTimer = setTimeout(() => {
      if (this.hintRequest !== id || this.state.workspace?.help?.id !== id) return;
      this.hintRequest = null; this.hintTimer = null;
      this.patch({ workspace: { ...this.state.workspace, help: { ...this.state.workspace.help, status: "unavailable", error: "The hint is taking longer than expected. Try again when ready." } } });
    }, 20_000);
  }
  skipTarget(targetItemId: string, reason = "Not applicable in this scene"): boolean {
    const opportunity = this.state.workspace?.opportunities?.find(value => value.session_item_id === targetItemId);
    if (!opportunity || opportunity.status === "skipped" || this.state.connection !== "connected") return false;
    const trimmed = reason.trim();
    if (!trimmed || trimmed.length > 200) return false;
    return this.send({ type: "target.skip", target_item_id: targetItemId, reason: trimmed });
  }
  restoreTarget(targetItemId: string): boolean {
    const opportunity = this.state.workspace?.opportunities?.find(value => value.session_item_id === targetItemId);
    if (opportunity?.status !== "skipped" || this.state.connection !== "connected") return false;
    return this.send({ type: "target.restore", target_item_id: targetItemId });
  }
  setSupport(level: SpeakingSupportLevel): boolean {
    const workspace = this.state.workspace;
    if (!workspace || this.state.connection !== "connected" || this.state.supportPending || !isSupportLevel(level)) return false;
    const support = currentSupport(workspace);
    if (support?.level === level) return false;
    const pending = { requestId: this.uuid(), level, expectedVersion: support?.version ?? 0 };
    if (!this.send({ type: "support.set", request_id: pending.requestId, level, expected_version: pending.expectedVersion })) return false;
    this.unconfirmedSupport = null;
    this.patch({ supportPending: pending, supportError: null });
    this.supportTimer = setTimeout(() => {
      if (this.state.supportPending?.requestId !== pending.requestId) return;
      this.supportTimer = null;
      this.unconfirmedSupport = pending;
      this.patch({ supportPending: null, supportError: "The support change is not confirmed. Check your connection and choose again." });
    }, 10_000);
    return true;
  }
  targetShown(targetItemId: string): void {
    const workspace = this.state.workspace;
    if (!workspace || !(workspace.session.mission_plan?.targets.some(value => value.session_item_id === targetItemId)
      || currentSupport(workspace) && workspace.session.items.some(value => value.id === targetItemId))) return;
    this.visibleTargets.add(targetItemId);
    if (this.state.connection !== "connected" || this.shownTargets.has(targetItemId)) return;
    if (this.send({ type: "target.shown", target_item_id: targetItemId })) this.shownTargets.add(targetItemId);
  }
  private retireAutomaticHint(): void {
    const workspace = this.state.workspace;
    if (workspace?.help?.source !== "automatic") return;
    this.retiredHints.add(workspace.help.id);
    this.patch({ workspace: { ...workspace, help: null } });
  }
  hintShown(id: string, version: number, level: SpeakingHelpLevel): void {
    const help = this.state.workspace?.help;
    if (!help || help.id !== id || help.version !== version || version < 1) return;
    if (help.source === "automatic" && this.state.userSpeaking) return;
    const rank = { direction: 0, usage: 1, example: 2 };
    if (rank[level] > rank[help.level]) return;
    if (level === "direction" ? !help.direction : level === "usage" ? !help.expression : help.status !== "ready" || !help.example) return;
    const key = `${id}:${version}:${level}`;
    if (this.shownHints.has(key)) return;
    if (this.send({ type: "hint.shown", hint_id: id, version, level })) this.shownHints.add(key);
  }
  messageShown(id: string, revision: number): void {
    const message = this.state.workspace?.messages.find(value => value.id === id && value.revision === revision);
    if (!message || message.role !== "assistant" || message.status === "unavailable" || !message.text.trim()) return;
    const key = `${id}:${revision}`;
    if (this.shownMessages.has(key)) return;
    if (this.send({ type: "message.shown", message_id: id, revision })) this.shownMessages.add(key);
  }
  private clearPlayback(): void {
    if (this.playingResponse) this.suppressedResponses.add(this.playingResponse);
    this.audio?.clear();
  }
  interrupt(): void { this.awaitingAudioClear = true; this.clearPlayback(); this.send({ type: "interrupt" }); this.patch({ phase: "listening" }); }
  pause(): void { if (["connected", "connecting"].includes(this.state.connection)) { this.closeRuntime(); this.patch({ connection: "paused", microphone: false, microphoneBusy: false, partials: {}, error: null, pending: this.state.pending ? { ...this.state.pending, status: "unconfirmed" } : null }); } }
  disconnect(message: string): void { this.closeRuntime(); this.patch({ connection: "disconnected", microphone: false, microphoneBusy: false, error: message, partials: {}, pending: this.state.pending ? { ...this.state.pending, status: "unconfirmed" } : null }); }
  async end(): Promise<boolean> {
    if (this.state.busy) return false;
    this.closeRuntime(); this.patch({ busy: true, microphone: false, microphoneBusy: false, connection: "disconnected", error: null, partials: {} });
    const epoch = this.epoch;
    try { const workspace = await this.api.end(this.abort.signal); if (!this.current(epoch) || !this.accept(workspace)) return false; this.patch({ busy: false, connection: "ended", pending: null }); return true; }
    catch (error) { if (this.current(epoch)) this.patch({ busy: false, error: this.message(error) }); return false; }
  }
  async delete(): Promise<boolean> {
    if (this.state.busy) return false;
    this.closeRuntime(); this.patch({ busy: true, microphone: false, microphoneBusy: false, connection: "disconnected", error: null });
    const epoch = this.epoch;
    try { await this.api.delete(this.abort.signal); return this.current(epoch); }
    catch (error) { if (this.current(epoch)) this.patch({ busy: false, error: this.message(error) }); return false; }
  }
  private closeRuntime(): void {
    this.epoch++;
    this.finishConnection?.(false); this.finishConnection = null;
    // Detach first: the final playback boundary may discover a broken socket and re-enter cleanup.
    const audio = this.audio; this.audio = null; audio?.dispose();
    this.playingResponse = null; this.suppressedResponses.clear(); this.awaitingAudioClear = false;
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = null; this.hintRequest = null;
    this.retiredHints.clear(); this.shownHints.clear(); this.shownMessages.clear(); this.shownTargets.clear();
    if (this.supportTimer) clearTimeout(this.supportTimer);
    this.supportTimer = null;
    if (this.state.supportPending) this.unconfirmedSupport = this.state.supportPending;
    this.patch({ userSpeaking: false, supportPending: null });
    if (this.heartbeat) clearInterval(this.heartbeat); if (this.boundary) clearInterval(this.boundary); if (this.readyTimer) clearTimeout(this.readyTimer); if (this.acknowledgementTimer) clearTimeout(this.acknowledgementTimer);
    this.acknowledgementTimer = null;
    this.heartbeat = null; this.boundary = null; this.readyTimer = null;
    if (this.socket) { this.socket.onmessage = null; this.socket.onopen = null; this.socket.onerror = null; this.socket.close(); this.socket = null; }
    this.abort.abort(); this.abort = new AbortController();
  }
  dispose(): void { this.closeRuntime(); this.disposed = true; this.state = initialConversationState(); }
}
