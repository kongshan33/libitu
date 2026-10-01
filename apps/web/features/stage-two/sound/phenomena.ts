import type { ComparisonView } from '../comparison/view';

export const phenomena = [
  {id:'linking',label:'Linking',symbol:'⌢',badge:'LK'},
  {id:'weak_form',label:'Weak',symbol:'ə',badge:'WK'},
  {id:'flap',label:'Flap-T',symbol:'ɾ',badge:'FT'},
  {id:'elision',label:'Elision',symbol:'∅',badge:'EL'},
  {id:'assimilation',label:'Assim.',symbol:'≈',badge:'AS'},
  {id:'glottal',label:'Glottal',symbol:'ʔ',badge:'GT'},
  {id:'drop_d',label:'Drop-D',symbol:'∅d',badge:'DD'},
  {id:'h_drop',label:'H-drop',symbol:'∅h',badge:'HD'},
  {id:'vowel_length',label:'Vowel len.',symbol:'◌',badge:'VL'},
  {id:'voicing',label:'Voicing',symbol:'◑',badge:'VC'},
] as const;
export type Phenomenon = typeof phenomena[number]['id'];
export type SoundMark = {id:string;kind:Phenomenon;start:number;end:number;description:string};
const ruleKinds = new Set<string>(['linking','weak_form','flap','elision','assimilation']);
export function soundMarks(view:ComparisonView):SoundMark[] {
  const words=view.reference.words;
  const marks:SoundMark[]=(view.sound?.candidates??[]).filter(c=>Number.isInteger(c.token_start)&&Number.isInteger(c.token_end)
    &&c.token_start>=0&&c.token_end>c.token_start&&c.token_end<=words.length).map(c=>({id:c.id,kind:c.kind,
      start:c.token_start,end:c.token_end,description:`Possible reading: ${c.explanation}`}));
  words.forEach((w,i)=>{if(w.vowel!==null||view.yours.words[i]?.vowel!=null)marks.push({id:`vowel-${i}`,kind:'vowel_length',start:i,end:i+1,
    description:'Measured vowel duration. This does not judge vowel quality.'});});
  return marks;
}
export function emptyPhenomenon(kind:Phenomenon|'all') {
  return kind==='all'?'No sound suggestions or vowel measurements are available for this sentence yet.':
    kind==='vowel_length'?'Vowel duration measurements are not available yet.':
      ruleKinds.has(kind)?'No suggestions of this type were found for this sentence.':
        'Automatic identification of this phenomenon is not available yet.';
}
