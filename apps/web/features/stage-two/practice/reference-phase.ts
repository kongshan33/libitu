/** A saved reference belongs to the current sentence; local preview work must not mask it. */
export function referencePhase(input: {
  preparing: boolean; uploading: boolean; serverState?: string; serverError: boolean;
  localPending: boolean; localError: boolean; localUsable: boolean;
}): 'idle' | 'preparing' | 'analyzing' | 'ready' | 'review' {
  if (input.preparing) return 'preparing';
  if (input.serverError) return 'review';
  if (input.serverState === 'completed') return 'ready';
  if (input.uploading || ['queued', 'processing'].includes(input.serverState ?? '')) return 'analyzing';
  if (['failed', 'cancelled', 'deleted', 'partially_completed', 'awaiting_upload'].includes(input.serverState ?? '')) return 'review';
  if (input.localPending) return 'analyzing';
  if (input.localError) return 'review';
  return input.localUsable ? 'ready' : 'idle';
}
