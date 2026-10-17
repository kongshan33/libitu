import type { ServerReference } from '../server-reference/api';

export type ReferenceStatus = {
  phase: 'idle' | 'analyzing' | 'ready' | 'review';
  title: string; description: string; action: string | null; needsUpload: boolean;
};

/** Describe the selected sentence, keeping uploaded audio separate from analysis readiness. */
export function referenceStatus(row: ServerReference | null, sentenceId?: string, now = Date.now()): ReferenceStatus | null {
  if (!row) return null;
  if (row.state === 'deleted' || !(Date.parse(row.expires_at) > now)) return {
    phase: 'review', title: !(Date.parse(row.expires_at) > now) ? 'Reference expired' : 'Reference deleted.',
    description: 'Prepare the original audio again for this sentence.', action: 'Prepare reference', needsUpload: true,
  };
  const result = row.results.find(value => value.sentence_id === sentenceId);
  const uploaded = row.audio_ready;
  const prefix = uploaded ? 'Reference audio is uploaded. ' : '';
  if (row.state === 'awaiting_upload') return {
    phase: 'review', title: 'Reference upload incomplete', description: 'The original audio has not finished uploading.',
    action: 'Retry reference upload', needsUpload: true,
  };
  if (uploaded && result?.coarse?.prominence.some(value => value !== null)
    && result.status !== 'completed') return {
    phase: row.state === 'queued' || row.state === 'processing' ? 'analyzing' : 'review',
    title: 'Reference preliminary results ready',
    description: row.state === 'queued' || row.state === 'processing'
      ? 'Pitch and relative prominence are ready. Precise word alignment is continuing.'
      : 'Pitch and relative prominence are saved. Precise word alignment did not finish.',
    action: row.state === 'queued' || row.state === 'processing' ? null : 'Retry reference analysis', needsUpload: false,
  };
  if (row.state === 'queued' || row.state === 'processing') return {
    phase: 'analyzing', title: !uploaded ? 'Preparing reference audio…'
      : row.state === 'queued' ? 'Reference queued for analysis…' : 'Analyzing reference words and pitch…',
    description: uploaded ? 'Reference uploaded. You can record while its analysis finishes.' : 'Preparing the original audio before analysis.',
    action: null, needsUpload: false,
  };
  if ((row.state === 'completed' || row.state === 'partially_completed') && uploaded
    && (sentenceId ? result?.status === 'completed' : row.state === 'completed')) return {
    phase: 'ready', title: 'Reference audio ready', description: result?.prosody?.content.status === 'source_transcript' ? 'Reference aligned to the source transcript and ready for comparison.' : 'Reference ready for this sentence.', action: null, needsUpload: false,
  };
  let reason = 'Analysis could not finish. Retry using the existing audio.';
  if (row.state === 'cancelled') reason = 'Analysis was cancelled. Retry using the existing audio.';
  else if (result?.prosody?.content.status === 'mismatch') reason = 'Recognized words differ from this sentence. Word alignment and three-layer comparison are unavailable.';
  else if (result?.prosody?.content.status === 'uncertain') reason = 'Speech recognition could not verify this sentence. Word alignment and three-layer comparison are unavailable.';
  else if (result?.alignment?.reason === 'reference_content_unverified') reason = 'The audio content could not be verified against this sentence. Word alignment and three-layer comparison are unavailable.';
  else if (result?.alignment?.reason === 'insufficient_audio_quality') reason = 'Audio quality is insufficient for word alignment and three-layer comparison.';
  else if (['mfa_version_mismatch', 'mfa_model_integrity', 'mfa_not_configured', 'mfa_unavailable', 'mfa_startup_failed'].includes(result?.alignment?.reason ?? '')) reason = 'The word-alignment service is unavailable. Your audio is saved; retry analysis after the service recovers.';
  else if (result?.alignment?.reason === 'mfa_timeout') reason = 'Word alignment timed out. Retry analysis using the uploaded audio.';
  else if (result?.alignment?.reason === 'mfa_alignment_failed') reason = 'Word alignment could not finish. Retry analysis using the uploaded audio.';
  else if (result?.alignment?.reason === 'mfa_dictionary_word_unavailable') reason = 'The pronunciation dictionary could not cover every source word. Word alignment and three-layer comparison are unavailable.';
  else if (['reference_alignment_invalid', 'reference_alignment_incomplete'].includes(result?.alignment?.reason ?? '')) reason = 'Word alignment did not pass timing and coverage checks. Three-layer comparison is unavailable.';
  else if (row.state === 'partially_completed' || row.state === 'completed') reason = 'Word alignment is incomplete for this sentence. Three-layer comparison is unavailable.';
  return {
    phase: 'review', title: !uploaded ? 'Reference preparation incomplete'
      : row.state === 'cancelled' ? 'Reference analysis cancelled' : row.state === 'failed' ? 'Reference analysis failed' : 'Reference analysis incomplete',
    description: uploaded ? prefix + reason : 'The original audio is not available yet. Retry reference preparation.',
    action: uploaded ? 'Retry reference analysis' : 'Retry reference preparation', needsUpload: !uploaded,
  };
}
