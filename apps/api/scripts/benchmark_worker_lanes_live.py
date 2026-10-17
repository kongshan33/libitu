"""Opt-in real storage/API/queue timing with local independently running workers.

Supply a public/synthetic WAV. Auth and source blueprint are test fixtures; uploads,
Postgres leases, inference, polling, and cleanup are real. No browser paint timing.
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
    parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    repo,refs=get_practice_analysis_repository(),get_reference_repository()
    identifier=str(uuid4());owner='lane-benchmark-'+identifier
    reference_id=None;takes=[]
    report={'scope':'local API TestClient + hosted Supabase + independent local workers; auth/source fixture; excludes browser paint',
            'poll_sleep_seconds':1, 'polling':'sequential Reference/Take requests; observations include HTTP and fixture creation','reference':{},'takes':[]}
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
                ref_start=time.perf_counter()
                response=client.post('/api/references/captures',json={'content_id':identifier,'segment_id':'segment','sentence_id':sentence.id,
                    'capture_id':identifier,'start_ms':origin,'end_ms':origin+duration,'sha256':sha256(audio).hexdigest(),
                    'size':len(audio),'consent_version':'reference-analysis-v1'})
                assert response.status_code==202,response.text
                reference_id=response.json()['id']
                response=client.put(f'/api/references/{reference_id}/audio',content=audio)
                assert response.status_code==200,response.text
                ref_uploaded=time.perf_counter();report['reference']['create_and_upload_sec']=ref_uploaded-ref_start
                def create_take(index):
                    start=time.perf_counter()
                    response=client.post('/api/practice/attempts',json={'client_id':str(uuid4()),'content_id':identifier,
                        'sentence_id':sentence.id,'duration_ms':duration,'playback_rate':1,'text_visible':True,'recording':None})
                    assert response.status_code==201,response.text
                    take=response.json()['id'];takes.append(take);url=f'/api/practice/attempts/{take}/analysis'
                    response=client.post(url,json={'consent_version':'practice-analysis-v1','size':len(recording),
                        'sha256':sha256(recording).hexdigest(),'mime_type':'audio/ogg','reference_id':reference_id})
                    assert response.status_code==202,response.text
                    response=client.put(url+'/audio',content=recording,headers={'content-type':'audio/ogg'})
                    assert response.status_code==200,response.text
                    uploaded=time.perf_counter()
                    item={'index':index,'create_and_upload_sec':uploaded-start,'events':{}}
                    report['takes'].append(item)
                    return {'url':url,'start':start,'uploaded':uploaded,'item':item,'done':False}
                jobs=[create_take(1)];ref_done=False;deadline=time.perf_counter()+300
                while time.perf_counter()<deadline:
                    if not ref_done:
                        response=client.get('/api/references/'+reference_id);assert response.status_code==200,response.text
                        current=response.json();now=time.perf_counter()
                        if any(r.get('coarse') for r in current['results']):report['reference'].setdefault('upload_to_coarse_observed_sec',now-ref_uploaded)
                        if current['state'] in ('completed','partially_completed','failed'):
                            ref_done=True;report['reference'].update(upload_to_final_observed_sec=now-ref_uploaded,state=current['state'])
                    for job in list(jobs):
                        if job['done']:continue
                        response=client.get(job['url']);assert response.status_code==200,response.text
                        current=response.json();now=time.perf_counter();events=job['item']['events']
                        if current.get('word_check'):
                            events.setdefault('word_check_sec',now-job['uploaded'])
                            job['item']['tier']=current['word_check']['tier']
                        if current.get('coarse'):
                            events.setdefault('coarse_sec',now-job['uploaded'])
                            if current['coarse'].get('reference'):events.setdefault('coarse_comparison_sec',now-job['uploaded'])
                            # Submit a second Take while the first still occupies fine.
                            if len(jobs)==1:jobs.append(create_take(2))
                        if current['state'] in ('completed','needs_review','failed'):
                            job['done']=True;events['final_sec']=now-job['uploaded']
                            job['item']['state']=current['state'];job['item']['error_code']=current.get('error_code')
                            job['item']['comparison']=(current.get('result') or {}).get('comparison')
                    save()
                    if ref_done and len(jobs)==2 and all(j['done'] for j in jobs):break
                    time.sleep(1)
                assert ref_done and len(jobs)==2 and all(j['done'] for j in jobs),'Worker timeout; partial timings saved'
                assert all(j['item']['state']=='completed' and j['item']['tier']=='full_85_plus' for j in jobs),report
                print(json.dumps(report,indent=2),flush=True)
        finally:
            app.dependency_overrides.clear()
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
            report['fixture_cleanup']='rows and audio removed';save()


if __name__=='__main__':main()
