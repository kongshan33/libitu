"""Offline benchmark. No account writes; cached boundaries are timing-only proxies."""
import argparse
import json
from pathlib import Path
from statistics import median
from tempfile import TemporaryDirectory
from time import perf_counter
from app.config import get_settings
from app.schemas.reference import Measurements, Alignment
from app.services.acoustics.signal_prosody import analyze_signal, mfa_boundaries, learner_boundaries
from app.services.acoustics.practice_prosody import normalize_take, check_learner_words
from app.services.acoustics import engine
from app.services.acoustics.transcribe import warm_up, close_resident


def main():
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--public-audio',type=Path)
    args=p.parse_args();rows=json.loads(args.input.read_text())
    report={'scope':'local CPU; no upload/database/browser latency; no accuracy labels','version':'server-prominence-v1','samples':[]}
    for row in rows:
        if row.get('timing_only'):continue
        m=Measurements.model_validate(row['measurements']);alignment=Alignment.model_validate(row['alignment']);bounds=mfa_boundaries(alignment)
        analyze_signal(m,bounds,'asr_word');durations=[]
        for _ in range(10):
            start=perf_counter();coarse=analyze_signal(m,bounds,'asr_word');durations.append((perf_counter()-start)*1000)
        start=perf_counter();fine=analyze_signal(m,bounds,'mfa',alignment=alignment);fine_ms=(perf_counter()-start)*1000
        report['samples'].append({'id':row['id'],'audio_sec':m.duration_sec,'coarse_median_ms':round(median(durations),2),
            'coarse_max_ms':round(max(durations),2),'fine_ms':round(fine_ms,2),'boundary_source_for_timing':'cached_mfa_proxy',
            'coarse_duration_channel':coarse.duration_evaluated,'uncertain_words':sum(w.uncertain for w in coarse.words),
            'words':len(coarse.words),'fine_duration_channel':fine.duration_evaluated})
    if args.public_audio:
        settings=get_settings();row=next(r for r in rows if r['id']=='speechocean762-000360034')
        text=' '.join(t['display'] for t in row['word_check']['source_tokens'])
        try:
            start=perf_counter();warm_up(settings);load=perf_counter()-start;runs=[]
            with TemporaryDirectory(prefix='libitu-preview-benchmark-') as tmp:
                wav=Path(tmp)/'learner.wav';normalize_take(args.public_audio,wav)
                for _ in range(3):
                    start=perf_counter();check=check_learner_words(wav,text,settings);asr=perf_counter()
                    frames,speech,samples=engine.extract(wav,settings)
                    measurements=engine.sentence_measurements(frames,speech,samples,0,len(samples)/16000);extracted=perf_counter()
                    signal=analyze_signal(measurements,learner_boundaries(check),'asr_word');end=perf_counter()
                    runs.append({'asr_sec':round(asr-start,3),'extract_sec':round(extracted-asr,3),'cwt_sec':round(end-extracted,3),
                        'first_signal_sec':round(end-start,3),'matched':check.matched_count,'source':check.source_count,
                        'tier':check.tier,'asr_word_timings':len(check.word_timings),'uncertain_words':sum(w.uncertain for w in signal.words)})
            report['public_learner']={'id':row['id'],'model_startup_sec':round(load,3),'runs':runs,'mfa_invocations':0}
        finally:close_resident()
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))


if __name__=='__main__':main()
