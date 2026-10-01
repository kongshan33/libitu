"""Opt-in live IO verification using synthetic audio, with fixture cleanup."""
import argparse
from datetime import datetime,timedelta,timezone
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4
import subprocess
from fastapi.testclient import TestClient
from app.auth import AuthenticatedUser,require_user
from app.config import Settings
from app.integrations.reference_repository import get_reference_repository
from app.main import app
from app.schemas.blueprint import Blueprint,BlueprintSegment,TranscriptLine
from app.services.acoustics.sources import SourceGrant
from app.workers.acoustic_worker import process


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-live',action='store_true',required=True);parser.parse_args()
    repo=get_reference_repository()
    if repo is None:raise SystemExit('Configure server Supabase access first.')
    content=str(uuid4());owner='reference-smoke-'+content;identifier=None;settings=Settings(_env_file=None)
    with TemporaryDirectory(prefix='libitu-reference-smoke-') as directory:
        audio=Path(directory)/'tone.wav'
        subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','sine=frequency=220:duration=1','-ar','16000','-ac','1',str(audio)],check=True)
        data=audio.read_bytes()
        grant=SourceGrant(id='synthetic-smoke',content_id=content,owners=[owner],rights_reference='Locally synthesized test tone',
            expires_at=datetime.now(timezone.utc)+timedelta(hours=1),mode='upload',origin_ms=120000,end_ms=121000,
            sha256=sha256(data).hexdigest(),size=len(data))
        line=TranscriptLine(id='sentence-v3-smoke',time='2:00',parts=['Synthetic tone.'],start_ms=120000,end_ms=121000,
            segmentation_version='sentence-v3',source_token_start=0,source_token_end=2)
        blueprint=Blueprint(id=str(uuid4()),content_id=content,title='Synthetic reference test',summary='',logic_flow=[],key_points=[],
            scenario_suggestions=[],transcript=[line],segments=[BlueprintSegment(id='segment',title='Test',summary='',start_ms=120000,
            end_ms=121000,transcript_start_index=0,transcript_end_index=1)])
        try:
            repo.database._request('POST','/contents',json={'id':content,'kind':'youtube','visibility':'public',
                'normalized_key':'reference-smoke:'+content,'title':'Synthetic reference verification','language':'en'})
            app.dependency_overrides[require_user]=lambda:AuthenticatedUser(id=owner)
            with patch('app.services.acoustics.sources.grants',return_value=[grant]),patch('app.services.reference_service.get_blueprint',return_value=blueprint),patch('app.services.reference_service.get_settings',return_value=settings),patch('app.routers.references.get_settings',return_value=settings):
                client=TestClient(app);payload={'content_id':content,'segment_id':'segment'}
                response=client.post('/api/references',json=payload)
                assert response.status_code==202,(response.status_code,response.text)
                identifier=response.json()['id'];path='/api/references/'+identifier
                assert client.post('/api/references',json=payload).json()['id']==identifier
                assert client.put(path+'/audio',content=data).json()['audio_ready']
                assert client.put(path+'/audio',content=data).status_code==200
                token=str(uuid4())
                repo.database._request('PATCH','/acoustic_references',params={'id':'eq.'+identifier},json={
                    'state':'processing','attempts':1,'lease_token':token,'lease_until':(datetime.now(timezone.utc)+timedelta(minutes=2)).isoformat()})
                process(repo,repo.get(owner,identifier),token,settings)
                result=client.get(path).json()
                assert result['state']=='partially_completed' and len(result['results'])==1,result
                assert client.get(path+'/audio',params={'sentence_id':line.id}).content.startswith(b'RIFF')
                assert client.post(path+'/retry').json()['state']=='queued'
                assert client.post(path+'/cancel').json()['state']=='cancelled'
                app.dependency_overrides[require_user]=lambda:AuthenticatedUser(id='other-'+owner)
                assert client.get(path).status_code==404 and client.get(path+'/audio').status_code==404
                app.dependency_overrides[require_user]=lambda:AuthenticatedUser(id=owner)
                assert client.delete(path).status_code==204 and client.get(path).status_code==410
                candidates=repo.cleanup_candidates(datetime.now(timezone.utc).isoformat(),(datetime.now(timezone.utc)-timedelta(days=1)).isoformat())
                assert any(r['id']==identifier for r in candidates)
                print('PASS: private upload, durable measurements, idempotency, ownership, replay, retry/cancel, deletion and reconciliation query.')
        finally:
            app.dependency_overrides.clear()
            if identifier:
                row=repo.get(owner,identifier)
                if row:repo.remove_audio(row)
                repo.database._request('DELETE','/acoustic_references',params={'id':'eq.'+identifier,'user_id':'eq.'+owner})
            repo.database._request('DELETE','/contents',params={'id':'eq.'+content})
            repo.database._request('DELETE','/profiles',params={'id':'eq.'+owner})
            print('Synthetic fixtures removed.')

if __name__=='__main__':main()
