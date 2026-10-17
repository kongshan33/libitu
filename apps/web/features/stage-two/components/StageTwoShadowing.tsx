'use client';
import { useAuth } from '@clerk/nextjs';
import { useCurrentLocation } from '../../navigation/use-current-location';
import { StageTwoDetailed, type StageTwoProps } from './StageTwoDetailed';
import { QuickShadowing } from '../quick/QuickShadowing';
import styles from '../quick/QuickShadowing.module.css';

export type ShadowMode = 'quick' | 'detailed' | 'review';
export function StageTwoShadowing(props: StageTwoProps) {
  const {userId} = useAuth();
  const href = useCurrentLocation();
  const value = new URL(href, 'https://libitu.invalid').searchParams.get('shadowMode');
  const mode: ShadowMode = value === 'detailed' || value === 'review' ? value : 'quick';
  function changeMode(next: ShadowMode) {
    const url = new URL(window.location.href);
    url.searchParams.set('shadowMode', next);
    window.history.replaceState(null, '', url);
    window.dispatchEvent(new Event('libitu:stage-two-location'));
  }
  const tabs = <nav className={styles.modes} aria-label="Shadow mode">
    {(['quick', 'detailed', 'review'] as const).map(item => <button key={item} type="button" aria-current={mode === item ? 'page' : undefined}
      onClick={() => changeMode(item)}>{item[0].toUpperCase()+item.slice(1)}</button>)}
  </nav>;
  return <>
    {mode === 'detailed' ? <StageTwoDetailed {...props} modes={tabs}/> : null}
    <QuickShadowing key={`${userId ?? 'anonymous'}:${props.contentId}:${props.segment.id}`} {...props} mode={mode} modes={tabs} onMode={changeMode}/>
  </>;
}
