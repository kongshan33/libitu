// Video offsets are estimates tied to verified, uninterrupted 1x playback.
// Never join a seek, pause, playback-rate change or missing PCM into one clip.
export const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
export const MAX_EXTRACT_BYTES = 24 * 1024 * 1024;

export function encodeMonoWav(samples, sampleRate) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const label = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  label(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); label(8, "WAVE");
  label(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return bytes;
}

export function createPcmReferenceBuffer({ sampleRate, maxBytes = MAX_BUFFER_BYTES, maxSeconds = 600, idFactory = () => crypto.randomUUID() }) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error("Unsupported capture sample rate.");
  const budget = Math.max(2, Math.min(MAX_BUFFER_BYTES, maxBytes, Math.floor(maxSeconds * sampleRate) * 2));
  let chunks = [];
  let spans = [];
  let retainedBytes = 0;
  let previous = null;
  let active = null;
  let latestFrame = -1;
  const eligible = (item) => item?.state === 1 && item.rate === 1;
  const clearContinuity = () => { active = null; };

  function observe(telemetry, audioTime) {
    const next = { ...telemetry, frame: audioTime * sampleRate };
    const elapsed = previous ? (next.wallTime - previous.wallTime) / 1000 : 0;
    const audioElapsed = previous ? (next.frame - previous.frame) / sampleRate : 0;
    const continuous = previous && eligible(previous) && eligible(next) && next.generation === previous.generation
      && elapsed > 0 && elapsed <= 0.75 && audioElapsed > 0 && audioElapsed <= 0.9
      && Math.abs(audioElapsed - elapsed) <= 0.1
      && Math.abs(next.time - previous.time - elapsed) <= 0.12;
    if (!continuous) clearContinuity();
    else {
      const predicted = active ? active.videoStart + (next.frame - active.frameStart) / sampleRate : next.time;
      if (active && Math.abs(predicted - next.time) > 0.12) clearContinuity();
      if (!active) {
        active = { captureId: idFactory(), frameStart: previous.frame, frameEnd: next.frame, videoStart: previous.time };
        spans.push(active);
      } else active.frameEnd = next.frame;
    }
    previous = next;
    // Thousands of seeks must not grow metadata without bound.
    if (spans.length > 4096) spans.splice(0, spans.length - 4096);
    prune();
  }

  function invalidate() { previous = null; clearContinuity(); }

  function prune() {
    if (!chunks.length) { spans = []; active = null; return; }
    const firstFrame = chunks[0].start;
    spans = spans.filter((span) => span.frameEnd > firstFrame);
    if (active && !spans.includes(active)) active = null;
  }

  function append(start, samples) {
    if (!(samples instanceof Int16Array) || !samples.length || !Number.isSafeInteger(start) || start < 0) return;
    const end = start + samples.length;
    if (start < latestFrame) { invalidate(); return; }
    latestFrame = end;
    // Discard idle data and stale telemetry, including suspended/background pages.
    if (!eligible(previous) || start / sampleRate > previous.frame / sampleRate + 0.75) return;
    if (samples.byteLength > budget) {
      const keep = Math.floor(budget / 2);
      samples = samples.slice(samples.length - keep);
      start = end - samples.length;
    }
    chunks.push({ start, end, samples }); retainedBytes += samples.byteLength;
    const cutoff = end - Math.floor(maxSeconds * sampleRate);
    while (chunks.length && (retainedBytes > budget || chunks[0].end <= cutoff)) {
      retainedBytes -= chunks[0].samples.byteLength; chunks.shift();
    }
    prune();
  }

  function coverage() {
    const pcmRanges = [];
    for (const chunk of chunks) {
      const last = pcmRanges.at(-1);
      if (last && last.end === chunk.start) last.end = chunk.end;
      else pcmRanges.push({ start: chunk.start, end: chunk.end });
    }
    const ranges = [];
    let index = 0;
    for (const span of spans) {
      while (index < pcmRanges.length && pcmRanges[index].end <= span.frameStart) index++;
      for (let j = index; j < pcmRanges.length && pcmRanges[j].start < span.frameEnd; j++) {
        const first = Math.ceil(Math.max(pcmRanges[j].start, span.frameStart));
        const last = Math.floor(Math.min(pcmRanges[j].end, span.frameEnd));
        if (last > first) ranges.push({
          start: span.videoStart + (first - span.frameStart) / sampleRate,
          end: span.videoStart + (last - span.frameStart) / sampleRate,
          frameStart: first, frameEnd: last, captureId: span.captureId, span
        });
      }
    }
    return ranges.slice(-4096);
  }

  function extract(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 60) {
      return { status: "missing", reason: "invalid_range" };
    }
    // A deliberate new listening pass supersedes an older usable capture.
    const match = coverage().findLast((range) => range.start <= start && range.end >= end);
    if (!match) return { status: "missing", reason: "not_covered" };
    const first = Math.ceil(match.span.frameStart + (start - match.span.videoStart) * sampleRate);
    const last = Math.floor(match.span.frameStart + (end - match.span.videoStart) * sampleRate);
    if (last <= first || (last - first) * 2 + 44 > MAX_EXTRACT_BYTES) return { status: "missing", reason: "too_large" };
    const samples = new Int16Array(last - first);
    let cursor = first;
    for (const chunk of chunks) {
      if (chunk.end <= cursor) continue;
      if (chunk.start > cursor) break;
      const until = Math.min(last, chunk.end);
      samples.set(chunk.samples.subarray(cursor - chunk.start, until - chunk.start), cursor - first);
      cursor = until;
      if (cursor === last) break;
    }
    if (cursor !== last) return { status: "missing", reason: "not_covered" };
    return { status: "complete", bytes: encodeMonoWav(samples, sampleRate), mimeType: "audio/wav",
      start, end, captureId: match.captureId, durationMs: samples.length / sampleRate * 1000 };
  }

  return { observe, append, invalidate, extract,
    snapshot: () => ({ ranges: coverage().map(({ start, end }) => ({ start, end })), retainedBytes,
      recording: eligible(previous) }),
    clear() { chunks = []; spans = []; retainedBytes = 0; previous = null; active = null; latestFrame = -1; }
  };
}
