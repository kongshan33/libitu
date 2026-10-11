export function contentContextFixture(blueprint, job) {
  return { content: { content_id: blueprint.content_id, kind: "youtube", source_url: blueprint.source_url,
    title: blueprint.title, language: "en" }, processing: { analysis_version: job.analysis_version,
    blueprint_available: job.status === "ready", job: { id: job.id, content_id: job.content_id,
      analysis_version: job.analysis_version, status: job.status, attempt_count: job.attempt_count ?? 1 } } };
}
