import type {ReactNode} from 'react';
import type {LayerAvailability} from '../persistence/practice-api';

export function PracticeLayerState({label,status,waitingReference,children}:{label:string;status?:LayerAvailability;waitingReference:boolean;children:ReactNode}) {
  if(status?.state==='pending')return <div className="shadow-layer-gate" role="status">{waitingReference?'Waiting for reference analysis.':`Analyzing your ${label}…`} You can keep practicing.</div>;
  if(status?.state==='unavailable')return <div className="shadow-layer-gate" role="status">{status.reason==='failed'||status.reason==='cancelled'?`${label} analysis did not finish.`:`${label} evidence is insufficient for this take.`} Replay it or record another take.</div>;
  return children;
}
