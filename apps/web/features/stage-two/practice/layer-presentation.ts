import type { LayerAvailability, PracticeAnalysis } from '../persistence/practice-api';
import type { PracticeLayer } from '../components/PracticeLayers';
import { layerLocks } from './flow.ts';

export type LayerBadge = { text: string; title: string; state: LayerAvailability['state'] };
const layers: PracticeLayer[] = ['sound', 'rhythm', 'melody'];

// Read the selected take only: recording or an unfinished word check must never
// expose a previous take's comparison. Legacy completed evidence remains viewable.
export function layerPresentation(data: PracticeAnalysis | null, reviewing: boolean, recording: boolean) {
  const legacy = Boolean(data?.result && data.analysis_version !== 'practice-gated-v3'
    && ['completed', 'needs_review'].includes(data.state));
  const visible = reviewing && !recording && data?.state !== 'deleted' && Boolean(data?.word_check || legacy);
  const locked = layerLocks(data, visible);
  const statuses = {} as Record<PracticeLayer, LayerAvailability>;
  const badges = {} as Record<PracticeLayer, LayerBadge>;
  for (const layer of layers) {
    const interrupted = data?.state === 'failed' || data?.state === 'cancelled';
    const pending = data && ['awaiting_upload', 'queued', 'processing'].includes(data.state);
    const status: LayerAvailability = locked[layer] ? { state: 'locked', reason: null }
      : interrupted ? { state: 'unavailable', reason: data?.state ?? null }
      : data?.layers?.[layer]?.reason === 'preliminary'
        ? pending ? { state: 'pending', reason: null } : finalLearnerStatus(data, layer)
        : data?.layers?.[layer] ?? { state: pending ? 'pending' : data?.result ? 'partial' : 'unavailable', reason: null };
    statuses[layer] = status;
    const matchedOnly = layer === 'sound' && data?.analysis_scope === 'sound_only';
    const score = layer === 'sound' ? null : data?.result?.assessment?.[layer]?.value;
    const measured = typeof score === 'number' && Number.isFinite(score);
    const threshold = layer === 'sound' ? 60 : 85;
    const text = status.state === 'locked' ? '🔒' : status.state === 'pending' ? '…'
      : status.state === 'unavailable' ? '—' : `${measured ? Math.round(score) : '✓'}${matchedOnly ? '*' : ''}`;
    const title = status.state === 'locked' ? `Requires ${threshold}% word matching`
      : status.state === 'pending' ? data?.phase === 'waiting_reference' ? 'Waiting for reference analysis' : 'Analysis in progress'
        : status.state === 'unavailable' ? interrupted ? 'Analysis did not finish' : 'Insufficient evidence'
          : measured ? `Experimental ${layer} similarity: ${Math.round(score)}/100`
            : status.reason === 'learner_only' ? 'Your measurements are ready; no Reference comparison'
            : matchedOnly ? 'Measurements ready for matched words only; no overall Sound score'
              : layer === 'sound' ? 'Measurements ready; no overall Sound score' : 'Measurements ready; comparison score unavailable';
    badges[layer] = { text, title, state: status.state };
  }
  return { visible, locked, statuses, badges };
}

// Cached coarse output is retained by the server, but the practice UI only shows
// final measurements. A missing Reference must not hide completed learner data.
function finalLearnerStatus(data: PracticeAnalysis, layer: PracticeLayer): LayerAvailability {
  const learner = data.result?.learner;
  const words = learner?.words?.filter(word => word.source_index !== null && word.source_index !== undefined) ?? [];
  const ready = ['completed', 'needs_review'].includes(data.state) && learner?.alignment_status === 'aligned'
    && (layer === 'rhythm' ? words.length >= 3 : layer === 'melody'
      ? words.some(word => word.pitch_curve_st.some(value => value !== null))
      : words.some(word => word.phones?.length));
  return { state: ready ? 'partial' : 'unavailable', reason: ready ? 'learner_only' : 'insufficient_evidence' };
}
