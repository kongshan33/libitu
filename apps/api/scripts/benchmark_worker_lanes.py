"""Local real ASR/CWT with concurrent real MFA; no account writes.

The serial mode reproduces a Take arriving behind an already-running MFA job.
Parallel modes separate workers; only yield mode suspends MFA during fast work.
"""
import argparse
from contextlib import nullcontext
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory
from time import perf_counter, sleep

from app.config import get_settings
from app.services.acoustics import cpu_policy, engine, mfa_runtime
from app.services.acoustics.practice_prosody import normalize_take, check_learner_words
from app.services.acoustics.signal_prosody import analyze_signal, learner_boundaries
from app.services.acoustics.transcribe import warm_up, close_resident


def fine(args):
    settings=get_settings()
    # Hold resource limits constant across modes, isolating queue/preemption effects.
    cpu_policy.configure(settings,'fine')
    os.environ[cpu_policy.LOCK_ENV]=str(args.work/'fast.lock')
    os.environ[cpu_policy.YIELD_ENV]='1' if args.mode=='yield' else '0'
    metrics=[]
    original=cpu_policy.run
    def timed(*a,**kw):
        result=original(*a,**kw)
        text=result.stderr.decode() if isinstance(result.stderr,bytes) else result.stderr or ''
        match=re.search(r'active_sec=([\d.]+) paused_sec=([\d.]+)',text)
        if match:metrics.append({'active_sec':float(match[1]),'paused_sec':float(match[2])})
        return result
    cpu_policy.run=timed
    start=perf_counter()
    (args.work/'ready').touch()
    result=engine.align(args.audio,args.text,0,args.work/'align',settings)
    (args.work/'fine.json').write_text(json.dumps({'wall_sec':perf_counter()-start,'status':result.status,
                                                'reason':result.reason,'scheduler':metrics}))


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--audio',type=Path,required=True)
    parser.add_argument('--text',required=True);parser.add_argument('--output',type=Path)
    parser.add_argument('--rounds',type=int,default=3);parser.add_argument('--fine',action='store_true')
    parser.add_argument('--work',type=Path);parser.add_argument('--mode',choices=['serial','parallel','yield'])
    args=parser.parse_args()
    if args.fine:return fine(args)
    settings=get_settings();cpu_policy.configure(settings,'fast')
    report={'scope':'local real inference, simulated arrival behind MFA; excludes upload, database and browser',
            'model':'small.en CPU int8, 2 threads, beam5; unchanged gates','runs':[]}
    start=perf_counter();warm_up(settings);report['resident_startup_sec']=perf_counter()-start
    try:
        mfa_runtime.check_startup(settings)
        with TemporaryDirectory(prefix='libitu-lanes-bench-') as tmp:
            root=Path(tmp);wav=root/'audio.wav';normalize_take(args.audio,wav)
            # Prewarm model assets/lexicon and signal runtime equally for every mode.
            prewarm=engine.align(wav,args.text,0,root/'prewarm',settings)
            assert prewarm.status=='aligned',prewarm
            engine.extract(wav,settings)
            for i in range(args.rounds):
                # Rotate ordering to avoid consistently favoring warm/thermal state.
                modes=['serial','parallel','yield'];modes=modes[i%3:]+modes[:i%3]
                for mode in modes:
                    work=root/f'{i}-{mode}';work.mkdir()
                    proc=subprocess.Popen([sys.executable,'-m','scripts.benchmark_worker_lanes','--fine',
                        '--audio',str(wav),'--text',args.text,'--work',str(work),'--mode',mode],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
                    try:
                        deadline=perf_counter()+30
                        while not (work/'ready').exists():
                            if proc.poll() is not None or perf_counter()>deadline:raise RuntimeError('Fine worker startup failed')
                            sleep(.02)
                        sleep(.5)
                        arrival=perf_counter()
                        if mode=='serial':proc.communicate(timeout=240)
                        start=perf_counter()
                        with cpu_policy.fast_activity(str(work/'fast.lock')) if mode=='yield' else nullcontext():
                            check=check_learner_words(wav,args.text,settings);checked=perf_counter()
                            frames,speech,samples=engine.extract(wav,settings)
                            measurements=engine.sentence_measurements(frames,speech,samples,0,len(samples)/16000);extracted=perf_counter()
                            coarse=analyze_signal(measurements,learner_boundaries(check),'asr_word');done=perf_counter()
                        proc.communicate(timeout=240)
                        result={'round':i+1,'mode':mode,'queue_wait_sec':start-arrival,'asr_sec':checked-start,
                            'extract_sec':extracted-checked,'cwt_sec':done-extracted,'arrival_to_coarse_sec':done-arrival,
                            'tier':check.tier,'matched':check.matched_count,'source':check.source_count,
                            'coarse_words':len(coarse.words),'fine':json.loads((work/'fine.json').read_text())}
                        assert result['fine']['status']=='aligned' and check.tier=='full_85_plus',result
                        report['runs'].append(result);print(json.dumps(result),flush=True)
                        args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,indent=2)+'\n')
                    finally:
                        if proc.poll() is None:proc.terminate();proc.communicate(timeout=10)
    finally:close_resident()


if __name__=='__main__':main()
