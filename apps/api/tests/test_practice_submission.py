from copy import deepcopy
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from uuid import uuid4
import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from app.auth import AuthenticatedUser, require_user
from app.main import app
from app.routers.practice_analysis import repository
from app.integrations.practice_repository import get_practice_repository
from app.services import practice_service, practice_analysis_service, practice_submission_service

DATA=b'OggSsubmission-test'


class SubmissionRepository:
    def __init__(self):
        self.context=None;self.audio=None;self.uploads=0;self.registers=0;self.after_upload=None
    def submission_context(self,owner,identifier):return deepcopy(self.context)
    def register_submission(self,owner,attempt,analysis):
        self.registers+=1
        if self.context is None:
            now=datetime.now(timezone.utc)
            self.context={'attempt':{**attempt,'created_at':now.isoformat()},'analysis':{**analysis,
                'input_expires_at':(now+timedelta(days=1)).isoformat(),'input_cleaned_at':None}}
        return deepcopy(self.context)
    def upload(self,row,data):
        self.audio=data;self.uploads+=1
        if self.after_upload:self.after_upload()
    def finalize_submission(self,owner,identifier):
        if self.context['attempt'].get('deleted_at'):raise HTTPException(409,'deleted')
        if self.context['analysis']['state']=='awaiting_upload':self.context['analysis']['state']='queued'
        return deepcopy(self.context)
    def remove_audio(self,row):self.audio=None


@pytest.fixture
def setup(monkeypatch):
    repo=SubmissionRepository()
    payload={'attempt':{'client_id':str(uuid4()),'content_id':str(uuid4()),'sentence_id':'s1','duration_ms':1000,
        'playback_rate':1,'text_visible':True,'recording':None},'analysis':{'consent_version':'practice-analysis-v1',
        'sha256':sha256(DATA).hexdigest(),'size':len(DATA),'mime_type':'audio/ogg','reference_id':None}}
    def build(repo,owner,p):
        identifier,digest=practice_service.attempt_identity(owner,p)
        return {'id':identifier,'user_id':owner,**p.model_dump(mode='json',exclude={'client_id','recording'}),
            'sentence_text':'one two three four','start_ms':0,'end_ms':1000,'reference_version':'v1',
            'request_hash':digest,'recording_state':'pending' if p.recording else 'none','deleted_at':None}
    monkeypatch.setattr(practice_service,'build_attempt',build)
    settings=practice_analysis_service.get_settings().model_copy(update={'practice_asr_model_path':'fixture','practice_asr_model_sha256':'a'*64})
    monkeypatch.setattr(practice_analysis_service,'get_settings',lambda:settings)
    def dependency():
        try:yield repo
        except httpx.HTTPError as error:raise HTTPException(503,"Temporarily unavailable") from error
    app.dependency_overrides[repository]=dependency
    app.dependency_overrides[get_practice_repository]=lambda:object()
    app.dependency_overrides[require_user]=lambda:AuthenticatedUser(id='owner')
    with TestClient(app) as client:yield client,repo,payload
    app.dependency_overrides.clear()


def submit(client,payload,audio=DATA,mime='audio/ogg'):
    import json
    return client.post('/api/practice/attempts/submit',data={'metadata':json.dumps(payload)},files={'audio':('take',audio,mime)})


def test_single_submission_without_retention(setup,monkeypatch):
    client,repo,payload=setup
    monkeypatch.setattr(practice_service,'upload_recording',lambda *_:pytest.fail('Independent retention remains off'))
    response=submit(client,payload)
    assert response.status_code==202,response.text
    assert response.json()['recording_state']=='none' and repo.audio==DATA
    assert repo.context['analysis']['state']=='queued' and repo.registers==repo.uploads==1
    assert 'user_id' not in response.json() and 'snapshot' not in response.json()


def test_uncertain_response_retry_keeps_id_and_never_reuploads_cleaned_analysis(setup):
    client,repo,payload=setup
    first=submit(client,payload);assert first.status_code==202
    repo.context['analysis'].update(state='completed',input_cleaned_at=datetime.now(timezone.utc).isoformat())
    repo.audio=None
    again=submit(client,payload)
    assert again.status_code==202 and again.json()['id']==first.json()['id']
    assert repo.uploads==1 and repo.audio is None and repo.context['analysis']['state']=='completed'
    changed=deepcopy(payload);changed['attempt']['duration_ms']=999
    assert submit(client,changed).status_code==409 and repo.uploads==1


def test_retention_retry_preserves_finished_analysis(setup,monkeypatch):
    client,repo,payload=setup
    payload['attempt']['recording']={**{k:v for k,v in payload['analysis'].items() if k in ('sha256','size','mime_type')},'consent_version':'recording-retention-v1'}
    calls=[]
    def retain(*args):
        calls.append(args)
        assert repo.context['analysis']['state'] in ('queued','completed')
        if len(calls)==1:
            repo.context['analysis'].update(state='completed',input_cleaned_at=datetime.now(timezone.utc).isoformat())
            repo.audio=None
            raise httpx.ConnectError('fixture storage outage')
        from app.schemas.practice import PracticeAttempt
        return PracticeAttempt.model_validate({**repo.context['attempt'],'recording_state':'ready'})
    monkeypatch.setattr(practice_service,'upload_recording',retain)
    assert submit(client,payload).status_code==503
    response=submit(client,payload)
    assert response.status_code==202 and response.json()['recording_state']=='ready'
    assert len(calls)==2 and repo.uploads==1 and repo.audio is None


@pytest.mark.parametrize('change,status', [('hash',422),('mime',422),('signature',415),('consent',422),('retention',422)])
def test_invalid_submission_never_creates_rows(setup,change,status):
    client,repo,payload=setup;audio=DATA;mime='audio/ogg'
    if change=='hash':payload['analysis']['sha256']='a'*64
    if change=='mime':mime='audio/webm'
    if change=='signature':
        audio=b'not-an-audio';payload['analysis'].update(size=len(audio),sha256=sha256(audio).hexdigest())
    if change=='consent':payload['analysis']['consent_version']='wrong'
    if change=='retention':payload['attempt']['recording']={**payload['analysis'],'consent_version':'recording-retention-v1','sha256':'a'*64}
    assert submit(client,payload,audio,mime).status_code==status
    assert repo.context is None and repo.uploads==0


def test_deletion_during_upload_wins_and_cleans_object(setup):
    client,repo,payload=setup
    repo.after_upload=lambda:repo.context['attempt'].update(deleted_at=datetime.now(timezone.utc).isoformat())
    assert submit(client,payload).status_code==409
    assert repo.audio is None
    assert submit(client,payload).status_code==409 and repo.uploads==1


def test_oversized_stream_and_duplicate_parts_rejected(setup):
    client,repo,payload=setup
    assert submit(client,payload,b'OggS'+b'x'*(8*1024*1024)).status_code==413
    assert client.post('/api/practice/attempts/submit',files=[('audio',('x',DATA,'audio/ogg')),('audio',('y',DATA,'audio/ogg'))]).status_code==422
    assert repo.context is None


def test_requires_auth_before_accepting_upload(setup):
    client,repo,payload=setup
    app.dependency_overrides.pop(require_user)
    assert submit(client,payload).status_code==401
    assert repo.context is None
