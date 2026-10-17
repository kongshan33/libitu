"""Opt-in browser submission timing with local independently running workers.

Supply a public/synthetic WAV. Auth and source blueprint are test fixtures; uploads,
Postgres leases, inference, polling, and cleanup are real. The temporary browser
harness uses production submission, polling and preliminary comparison components.
"""
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import time
from unittest.mock import patch
from uuid import uuid4
import wave
import threading
import shutil
import uvicorn
from contextvars import ContextVar

from app.auth import AuthenticatedUser, require_user
from app.integrations.practice_analysis_repository import get_practice_analysis_repository
from app.integrations.reference_repository import get_reference_repository
from app.main import app
from app.schemas.blueprint import Blueprint, BlueprintSegment, TranscriptLine
from scripts.verify_practice_analysis import RetryClient


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-live',action='store_true',required=True)
    parser.add_argument('--audio',type=Path,required=True);parser.add_argument('--text',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--compare-reads',action='store_true',help='Compare serial and snapshot reads, both with merged submission')
    parser.add_argument('--final-results',action='store_true',help='Measure current final three-layer rendering instead of old preview UI')
    parser.add_argument('--without-reference',action='store_true',help='Analyze only learner audio')
    parser.add_argument('--trials',type=int,default=3)
    args=parser.parse_args()
    if args.final_results and args.compare_reads:parser.error('Final results and read comparison are separate modes')
    if args.trials < 1:parser.error('Trials must be positive')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    repo,refs=get_practice_analysis_repository(),get_reference_repository()
    identifier=str(uuid4());owner='lane-benchmark-'+identifier
    reference_id=None;takes=[]
    report={'scope':'local API TestClient + hosted Supabase + independent local workers; auth/source fixture; includes benchmark browser rendering',
            'poll_sleep_seconds':1, 'polling':'production hook waits 1s after each response; browser records DOM publication plus two animation frames','reference':{},'takes':[]}
    api_events=[]
    http_events=[]
    request_calls=ContextVar("benchmark_request_calls",default=None)
    original_request=repo.database._request
    def traced_request(method,path,**kwargs):
        started=time.perf_counter();epoch=time.time()
        try:return original_request(method,path,**kwargs)
        finally:
            event={'method':method,'path':path,'epoch':epoch,'seconds':time.perf_counter()-started}
            api_events.append(event)
            current=request_calls.get()
            if current is not None:current.append(event)
    repo.database._request=traced_request
    async def timed_app(scope,receive,send):
        if scope['type']!='http':
            return await app(scope,receive,send)
        calls=[];token=request_calls.set(calls);started=time.perf_counter();epoch=time.time()
        try:await app(scope,receive,send)
        finally:
            http_events.append({'method':scope['method'],'path':scope['path'],'epoch':epoch,
                'seconds':time.perf_counter()-started,'database_calls':len(calls),
                'database_seconds':sum(c['seconds'] for c in calls)})
            request_calls.reset(token)
    original_routes=list(app.router.routes)
    if args.compare_reads:
        from scripts.fixtures.practice_analysis_serial_read import read as serial_read
        from uuid import UUID
        def serial_status(attempt_id: UUID):
            return serial_read(repo,owner,str(attempt_id))
        app.add_api_route('/benchmark/serial/{attempt_id}',serial_status,methods=['GET'])
    def save():
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(report,indent=2)+'\n')
    with TemporaryDirectory(prefix='libitu-lane-live-') as tmp:
        wav,ogg=Path(tmp)/'reference.wav',Path(tmp)/'take.ogg'
        subprocess.run(['ffmpeg','-v','error','-i',str(args.audio),'-ac','1','-ar','16000','-c:a','pcm_s16le',str(wav)],check=True)
        subprocess.run(['ffmpeg','-v','error','-i',str(wav),'-c:a','libopus',str(ogg)],check=True)
        audio=wav.read_bytes();recording=ogg.read_bytes()
        with wave.open(str(wav)) as f:duration=round(f.getnframes()*1000/f.getframerate())
        origin=120000
        sentence=TranscriptLine(id='sentence-v3-lane-benchmark',time='2:00',parts=[args.text],start_ms=origin,
            end_ms=origin+duration,segmentation_version='sentence-v3',source_token_start=0,source_token_end=len(args.text.split()))
        blueprint=Blueprint(id=str(uuid4()),content_id=identifier,title='Public audio worker lane benchmark',summary='',
            logic_flow=[],key_points=[],scenario_suggestions=[],transcript=[sentence],segments=[BlueprintSegment(id='segment',
            title='Test',summary='',start_ms=origin,end_ms=origin+duration,transcript_start_index=0,transcript_end_index=1)])
        try:
            repo.database._request('POST','/contents',json={'id':identifier,'kind':'youtube','visibility':'public',
                'normalized_key':'lane-benchmark:'+identifier,'title':blueprint.title,'language':'en'})
            app.dependency_overrides[require_user]=lambda:AuthenticatedUser(id=owner)
            with patch('app.services.reference_service.get_blueprint',return_value=blueprint), \
                 patch('app.services.reference_service.personalize_blueprint',return_value=blueprint), \
                 patch('app.services.practice_service.get_blueprint',return_value=blueprint), \
                 patch('app.services.practice_service.find_blueprint_sentence',return_value=sentence), RetryClient(app) as client:
                if not args.without_reference:
                    ref_start=time.perf_counter()
                    response=client.post('/api/references/captures',json={'content_id':identifier,'segment_id':'segment','sentence_id':sentence.id,
                        'capture_id':identifier,'start_ms':origin,'end_ms':origin+duration,'sha256':sha256(audio).hexdigest(),
                        'size':len(audio),'consent_version':'reference-analysis-v1'})
                    assert response.status_code==202,response.text
                    reference_id=response.json()['id']
                    response=client.put(f'/api/references/{reference_id}/audio',content=audio)
                    assert response.status_code==200,response.text
                    ref_uploaded=time.perf_counter();report['reference']['create_and_upload_sec']=ref_uploaded-ref_start
                    deadline=time.perf_counter()+180
                    while time.perf_counter()<deadline:
                        current=client.get('/api/references/'+reference_id).json()
                        if current['state']=='completed':break
                        if current['state'] in ('failed','partially_completed'):raise RuntimeError(current['state'])
                        time.sleep(1)
                    else:raise TimeoutError('Reference preparation')
                    report['reference']['ready_sec']=time.perf_counter()-ref_start
                root=Path(__file__).resolve().parents[3]
                page=root/'apps/web/app/dev/submission-benchmark/page.tsx'
                fixture=root/'apps/web/tests/fixtures/submission-benchmark.tsx'
                if page.exists():raise RuntimeError('Benchmark route already exists')
                page.parent.mkdir(parents=True)
                page.write_text(fixture.read_text())
                config=Path(tmp)/'browser.json'
                browser_output=args.output.resolve().with_name('browser.json')
                config.write_text(json.dumps({'owner':owner,'content':identifier,'sentence':sentence.id,'reference':reference_id,
                    'duration':duration,'audio':str(ogg),'output':str(browser_output),'compare_reads':args.compare_reads,
                    'final_results':args.final_results,'trials':args.trials,'text':args.text}))
                server=uvicorn.Server(uvicorn.Config(timed_app,host='127.0.0.1',port=8001,log_level='warning'))
                thread=threading.Thread(target=server.run,daemon=True);thread.start()
                try:
                    startup=time.perf_counter()+15
                    while not server.started:
                        if time.perf_counter()>startup:raise TimeoutError('Fixture API startup')
                        time.sleep(.1)
                    subprocess.run(['node',str(root/'apps/web/tests/benchmark-submission.browser.mjs'),str(config)],check=True)
                    report['browser']=json.loads(browser_output.read_text())
                    report['scope']='Chromium harness with production Outbox/API/poll hook and '+('final layer components' if args.final_results else 'preview components')+'; real local API, hosted DB/storage and independent workers; fixture auth/source; '+('no Reference' if args.without_reference else 'prepared Reference')
                finally:
                    page.unlink(missing_ok=True);page.parent.rmdir()
                    shutil.rmtree(root/'apps/web/.next/types/app/dev/submission-benchmark',ignore_errors=True)
                    server.should_exit=True;thread.join(timeout=10)
        finally:
            app.dependency_overrides.clear()
            app.router.routes[:]=original_routes
            takes=[r['id'] for r in repo.database._request('GET','/shadow_attempts',params={'user_id':'eq.'+owner,'select':'id'}).json()]
            for take in takes:
                row=repo.get(owner,take)
                if row:
                    repo.control(owner,take,'cancel');repo.remove_audio(row)
                repo.database._request('DELETE','/practice_analyses',params={'id':'eq.'+take,'user_id':'eq.'+owner})
            repo.database._request('DELETE','/shadow_attempts',params={'user_id':'eq.'+owner})
            if reference_id:
                row=refs.get(owner,reference_id)
                if row:
                    refs.control(owner,reference_id,'delete');refs.remove_audio(row)
                repo.database._request('DELETE','/acoustic_references',params={'id':'eq.'+reference_id,'user_id':'eq.'+owner})
            repo.database._request('DELETE','/contents',params={'id':'eq.'+identifier})
            repo.database._request('DELETE','/profiles',params={'id':'eq.'+owner})
            report['fixture_cleanup']='rows and audio removed'
            report['api_database_calls']=api_events
            report['http_requests']=http_events
            report['comparison']='current final three-layer rendering' if args.final_results else 'serial versus snapshot status reads; both merged submission' if args.compare_reads else 'legacy versus merged submission'
            repo.database._request=original_request
            save()


if __name__=='__main__':main()
