import type { SpeakingFeedback } from "@libitu/types/speaking";
import { FeedbackApiError, type FeedbackApi } from "./api.ts";
export type ReportState = { report: SpeakingFeedback | null; loading: boolean; error: string | null; errorStatus: number | null; pollingPaused: boolean };
export const feedbackPending = (report: SpeakingFeedback | null) => report?.status === "queued" || report?.status === "processing";

/** Polls committed report state only; generation and paid retries are separate actions. */
export class FeedbackController {
  state: ReportState = { report: null, loading: true, error: null, errorStatus: null, pollingPaused: false };
  private abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private count = 0;
  private found = false;
  private busy = false;
  constructor(private readonly api: FeedbackApi, private readonly publish: (state: ReportState) => void,
    private readonly intervalMs = 2000, private readonly maxPolls = 90) {}
  private update(patch: Partial<ReportState>) { if (!this.abort.signal.aborted) { this.state = { ...this.state, ...patch }; this.publish(this.state); } }
  dispose() { this.abort.abort(); if (this.timer) clearTimeout(this.timer); this.timer = null; }
  async load() { await this.read(!this.found); }
  async refresh() { this.count = 0; if (this.timer) clearTimeout(this.timer); await this.read(!this.found); }
  async retry() { if (this.state.report?.retryable && !this.busy) { this.count = 0; if (this.timer) clearTimeout(this.timer); this.timer = null; await this.read(false, true); } }
  private async read(allowCreate: boolean, retry = false) {
    if (this.busy || this.abort.signal.aborted) return;
    this.busy = true; this.update({ loading: true, error: null, errorStatus: null, pollingPaused: false });
    try {
      let report: SpeakingFeedback;
      if (retry) report = await this.api.create(true, this.abort.signal);
      else {
        try { report = await this.api.read(this.abort.signal); }
        catch (error) { if (!(allowCreate && error instanceof FeedbackApiError && error.status === 404)) throw error; this.abort.signal.throwIfAborted(); report = await this.api.create(false, this.abort.signal); }
      }
      this.abort.signal.throwIfAborted();
      this.found = true;
      this.update({ report, loading: false });
      if (feedbackPending(report)) {
        if (this.count++ < this.maxPolls) this.timer = setTimeout(() => { this.timer = null; void this.read(false); }, this.intervalMs);
        else this.update({ pollingPaused: true });
      }
    } catch (error) {
      if (!this.abort.signal.aborted) this.update({ loading: false, error: error instanceof Error ? error.message : "The report could not be loaded. Please try again.", errorStatus: error instanceof FeedbackApiError ? error.status : 0, ...(error instanceof FeedbackApiError && [401, 404].includes(error.status) ? { report: null } : {}) });
    } finally { this.busy = false; }
  }
}
