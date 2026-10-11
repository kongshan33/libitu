import type { ContentJobSummary } from "@libitu/types/stage-one";
import { canonicalVideoSource } from "../navigation/learning-location.ts";
import { selectCorpusItems } from "@libitu/core/stage-one";
import { annotateTranscriptLine, assertReadyJob, ensureContentProcessing, readContentContext,
  readLearningBlueprint, readProcessingJob, StageOneApiError, waitForJob,
  type StageOneSource, type StageOneAnalysisPreview, type ApiProcessingJob } from "../stage-one/api/stage-one-api.ts";

export type WorkspaceSource = Pick<StageOneSource, "kind" | "sourceUrl" | "title" | "language" | "learnerLevel"> & { contentId: string };

export type WorkspaceLoadOptions = {
  signal: AbortSignal;
  retry?: ContentJobSummary;
  onRetryAccepted?(): void;
  onSource?(source: WorkspaceSource): void;
  onJob?(job: ContentJobSummary | null): void;
  onProgress?(message: string): void;
  onPreview?(preview: StageOneAnalysisPreview): void;
};

/** One activation: read first, ensure only missing work, retry only the observed generation. */
export async function loadContentWorkspace(input: WorkspaceSource, options: WorkspaceLoadOptions) {
  const { signal } = options;
  signal.throwIfAborted();
  if (!input.contentId) throw new StageOneApiError("Open a content page to begin learning.", 422, "unsupported");
  const contentId = input.contentId;
  let source = { ...input };
  const context = await readContentContext(contentId, signal);
  const canonical = canonicalVideoSource(context.content.source_url);
  if (!canonical || (source.sourceUrl && canonicalVideoSource(source.sourceUrl) !== canonical)) {
    throw new StageOneApiError("The content does not match this learning link. Open the original video again.", 409);
  }
  source = { ...source, sourceUrl: canonical, title: context.content.title ?? "YouTube video",
    language: context.content.language ?? undefined };
  options.onSource?.(source);
  const job = context.processing.job;
  options.onJob?.(job);
  if (!context.processing.blueprint_available) {
    if (options.retry && options.retry.analysis_version !== context.processing.analysis_version) {
      throw new StageOneApiError("The processing version changed. Reload this content.", 409);
    }
    let full: ApiProcessingJob | undefined = job ? await readProcessingJob(job.id, signal) : undefined;
    if (full && (full.content_id !== contentId || full.analysis_version !== context.processing.analysis_version)) {
      throw new StageOneApiError("The processing job changed identity.", 409);
    }
    if (options.retry || !job) {
      full = await ensureContentProcessing(contentId, options.retry, signal);
      options.onRetryAccepted?.();
    }
    if (!full || full.analysis_version !== context.processing.analysis_version || full.content_id !== contentId) {
      throw new StageOneApiError("The processing version changed. Reload this content.", 409);
    }
    options.onJob?.(full);
    const completed = await waitForJob(full, options.onProgress, preview => {
      const corpusItems = selectCorpusItems(preview.corpusItems, source.learnerLevel);
      options.onPreview?.({ ...preview, corpusItems,
        transcriptLines: preview.transcriptLines.map(line => annotateTranscriptLine(line, corpusItems)) });
    }, signal);
    options.onJob?.(completed);
    assertReadyJob(completed);
  }
  // Publication may lag a ready snapshot; bounded reads never create another job.
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await readLearningBlueprint({ ...source, contentId }, signal); }
    catch (error) {
      if (!(error instanceof StageOneApiError) || error.status !== 404 || attempt === 2) throw error;
      await readContentContext(contentId, signal);
    }
  }
  throw new StageOneApiError("The completed blueprint is not available yet. Try loading again.");
}
