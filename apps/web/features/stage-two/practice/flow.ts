import type { CheckedToken, PracticeAnalysis, TextSupport } from '../persistence/practice-api.ts';
import type { PracticeLayer } from '../components/PracticeLayers';

// Keep these offsets in UTF-16 for DOM rendering; server indices are token positions.
export function practiceTokens(text: string): CheckedToken[] {
  let normalized = ''; const origins: {start:number;end:number}[] = [];
  const clusters = Array.from(text.matchAll(/[^\p{M}]\p{M}*|\p{M}+/gu));
  for (const cluster of clusters) {
    const start = cluster.index!, end = start + cluster[0].length;
    const value = cluster[0].normalize('NFKC').toLowerCase().replaceAll('’', "'");
    normalized += value;
    for (let i=0;i<value.length;i++) origins.push({start,end});
  }
  return Array.from(normalized.matchAll(/[a-z0-9]+(?:'[a-z0-9]+)*/g), match => {
    const start=origins[match.index!].start, end=origins[match.index!+match[0].length-1].end;
    return {normalized:match[0],display:text.slice(start,end),start,end};
  });
}
export const FUNCTION_WORDS = new Set("a an the and or but so if as of to in on at by for from with about into through after before is am are was were be been being do does did have has had can could will would shall should may might must i me my we us our you your he him his she her it its they them their this that these those not no".split(' '));
export function visiblePositions(tokens: readonly CheckedToken[], mode: TextSupport['mode'], revealed: readonly number[]) {
  return tokens.flatMap((token,i)=>mode==='full'||revealed.includes(i)||(mode==='keywords'&&!FUNCTION_WORDS.has(token.normalized))?[i]:[]);
}
export function supportSnapshot(mode: TextSupport['mode'], visible: readonly number[], revealed: readonly number[]): TextSupport {
  return {version:'text-support-v1',mode,visible_source_indices_at_start:[...visible],revealed_source_indices:[...revealed]};
}
export function layerLocks(data: PracticeAnalysis|null, reviewing: boolean): Record<PracticeLayer,boolean> {
  if (!reviewing) return {sound:true,rhythm:true,melody:true};
  // Legacy evidence stays viewable without inventing a percentage.
  if (!data?.word_check) {
    const legacy=Boolean(data?.result && ['completed','needs_review'].includes(data.state) && data.analysis_version!=='practice-gated-v3');
    return {sound:!legacy,rhythm:!legacy,melody:!legacy};
  }
  const scope=data.analysis_scope;
  return {sound:scope!=='sound_only'&&scope!=='all_layers',rhythm:scope!=='all_layers',melody:scope!=='all_layers'};
}
export function matchLabel(data: PracticeAnalysis|null) {
  const check=data?.word_check;
  if(!check||check.status!=='reliable'||!check.source_count)return null;
  const value=Math.floor(check.matched_count*1000/check.source_count)/10;
  return `${value}% of words matched`;
}
export function nextPracticeIndex(sentences:readonly {text:string}[], index:number, direction:number, skipShort:boolean) {
  if(direction!==-1&&direction!==1)return null;
  for(let i=index+direction;i>=0&&i<sentences.length;i+=direction) {
    if(!skipShort||practiceTokens(sentences[i].text).length>=4)return i;
  }
  return null;
}
