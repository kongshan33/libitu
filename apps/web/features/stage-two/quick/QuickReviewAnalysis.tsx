'use client';
import { useMemo, useState } from 'react';
import type { SentenceUnit } from '@libitu/types/stage-two';
import type { PracticeApi } from '../persistence/practice-api';
import { useSoundGuide } from '../sound/use-sound-guide';
import { comparisonView } from '../comparison/view';
import { layerPresentation } from '../practice/layer-presentation';
import { PracticeLayers, type PracticeLayer } from '../components/PracticeLayers';
import { PracticeLayerState } from '../components/PracticeLayerState';
import { LayerComparison, type ComparisonPlayback } from '../components/LayerComparison';
import { ProgressiveComparison } from '../components/ProgressiveComparison';
import { PracticeAnalysisPanel } from '../components/PracticeAnalysisPanel';
import type { QuickTake } from './use-quick-takes';

export function QuickReviewAnalysis({content, sentence, take, api, reload, playback}: {
  content: string; sentence: SentenceUnit; take: QuickTake; api?: PracticeApi; reload(): void; playback: ComparisonPlayback;
}) {
  const [layer, setLayer] = useState<PracticeLayer>('sound');
  const guide = useSoundGuide(content, sentence.id, sentence.text);
  const data = take.analysis ?? null;
  const presentation = layerPresentation(data, true, false);
  const active = presentation.locked[layer] ? 'sound' : layer;
  const view = useMemo(() => comparisonView({sentence, guide: guide.data, data, server: null, reference: null, yours: null}), [sentence, guide.data, data]);
  const panel = (name: PracticeLayer) => <PracticeLayerState label={name[0].toUpperCase()+name.slice(1)} status={presentation.statuses[name]} waitingReference={data?.phase === 'waiting_reference'}>
    <LayerComparison layer={name} view={view} playback={playback}/>
    {name === 'rhythm' && data?.result?.learner.rhythm_signal ? <ProgressiveComparison layer="rhythm" fine pair={{learner: data.result.learner.rhythm_signal, reference: data.result.reference?.rhythm_signal ?? null}}/> : null}
  </PracticeLayerState>;
  return <>
    {presentation.visible ? <PracticeLayers active={active} onChange={setLayer} locked={presentation.locked} badges={presentation.badges}
      gate={<><strong>Word matching comes first</strong><p>Sound opens at 60%. Rhythm and Melody open at 85%.</p></>}
      sound={panel('sound')} rhythm={panel('rhythm')} melody={panel('melody')}/> : null}
    {guide.error && presentation.visible ? <p role="alert">Sound guide unavailable. <button onClick={guide.retry}>Retry guide</button></p> : null}
    <PracticeAnalysisPanel api={api} attemptId={take.id} data={data} error={take.error ?? null} loading={Boolean(take.id && !take.loaded)} reload={reload}/>
  </>;
}
