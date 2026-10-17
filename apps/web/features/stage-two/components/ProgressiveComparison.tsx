import type { SignalPair, SignalProsody } from '../persistence/practice-api';
import styles from './ProgressiveComparison.module.css';

function Curve({ signal, layer, label, scale }: { signal: SignalProsody; layer: 'rhythm' | 'melody'; label: string; scale: number }) {
  const values = layer === 'melody' ? signal.pitch_st : signal.prominence;
  // Nulls break the path: never draw invented pitch across unvoiced gaps.
  let drawing = false;
  const path = values.map((value, i) => {
    if (value === null) { drawing = false; return ''; }
    const x = 8 + i * signal.time_step_sec / signal.duration_sec * 584;
    const y = layer === 'melody' ? 55 - value / scale * 43 : 100 - value / scale * 86;
    const command = `${drawing ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    drawing = true;
    return command;
  }).join(' ');
  return <figure className={styles.curve}>
    <figcaption><strong>{label}</strong><span>{signal.duration_sec.toFixed(2)} s · {signal.boundary_source === 'mfa' ? 'Aligned word timing' : 'Approximate word timing'}</span></figcaption>
    {values.some(v => v !== null) ? <svg viewBox="0 0 600 112" role="img" aria-label={`${label}: ${layer === 'melody' ? 'pitch relative to own median' : 'relative prominence'} over this recording`}>
      <line x1="8" x2="592" y1={layer === 'melody' ? 55 : 100} y2={layer === 'melody' ? 55 : 100} stroke="currentColor" opacity=".2" />
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" />
    </svg> : <p>Insufficient signal evidence.</p>}
    <div className={styles.axis}><span>0 s</span><span>{signal.duration_sec.toFixed(2)} s</span></div>
  </figure>;
}

export function ProgressiveComparison({ pair, layer, fine = false }: { pair: SignalPair; layer: 'rhythm' | 'melody'; fine?: boolean }) {
  const signals = [pair.reference, pair.learner].filter((v): v is SignalProsody => Boolean(v));
  const values = signals.flatMap(v => layer === 'melody' ? v.pitch_st : v.prominence);
  const scale = values.reduce<number>((max, value) => Math.max(max, Math.abs(value ?? 0)), layer === 'melody' ? 2 : .1);
  const referenceWords = new Map(pair.reference?.words.filter(w => w.source_index !== null).map(w => [w.source_index, w]));
  const words = pair.learner.words.filter(w => w.source_index !== null);
  return <section className={styles.root} aria-label={`${fine ? 'Refined' : 'Preliminary'} ${layer}`}>
    <strong>{fine ? 'Relative prominence · precise word boundaries' : `Preliminary ${layer === 'melody' ? 'Melody' : 'Rhythm'}`}</strong>
    <p>{layer === 'melody' ? 'Pitch is relative to each speaker’s median, in semitones. Each curve uses its own recording time.'
      : 'Continuous relative prominence, not a stress label or a correctness score. Larger values indicate more local prominence.'}</p>
    {layer === 'rhythm' && (!fine || !signals.every(v => v.duration_evaluated)) ? <p>Lengthening is not evaluated here. Emphasis expressed through duration remains uncertain.</p> : null}
    {!pair.reference ? <p role="status">Your voice is analyzed independently. No Reference comparison is available.</p> : null}
    <div className={styles.curves}>
      {pair.reference ? <Curve signal={pair.reference} layer={layer} label="Reference" scale={scale}/> : null}
      <Curve signal={pair.learner} layer={layer} label="Your voice" scale={scale}/>
    </div>
    <small>{layer === 'melody' ? `Shared vertical scale: ±${scale.toFixed(1)} semitones.` : `Shared vertical scale: 0–${scale.toFixed(2)} relative units.`} Curves are not time-aligned.</small>
    {layer === 'rhythm' && words.length ? <div className={styles.table}><table>
      <caption>Matched words · relative prominence</caption>
      <thead><tr><th scope="col">Word</th>{pair.reference ? <th scope="col">Reference</th> : null}<th scope="col">Your voice</th><th scope="col">Evidence</th></tr></thead>
      <tbody>{words.map((word, index) => {
        const reference = referenceWords.get(word.source_index);
        const uncertain = word.uncertain || Boolean(pair.reference && (!reference || reference.uncertain));
        return <tr key={index}><th scope="row">{word.text}</th>{pair.reference ? <td>{reference?.value?.toFixed(2) ?? '—'}</td> : null}<td>{word.value?.toFixed(2) ?? '—'}</td>
          <td>{uncertain ? 'Uncertain' : 'Relative estimate'}</td></tr>;
      })}</tbody>
    </table></div> : layer === 'rhythm' ? <p>Reliable word boundaries are unavailable; only the sentence curve is shown.</p> : null}
    {layer === 'rhythm' ? <small>Uncertainty includes boundary sensitivity, limited pitch and sentence edges. These estimates have not been calibrated against human stress labels.</small> : null}
  </section>;
}
