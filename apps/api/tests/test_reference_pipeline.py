from copy import deepcopy
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from uuid import uuid4
import math
import struct
import wave

from fastapi.testclient import TestClient
import httpx
import pytest

from app.auth import AuthenticatedUser, require_user
from app.config import Settings
from app.main import app
from app.routers.references import repository
from app.schemas.blueprint import Blueprint, BlueprintSegment, TranscriptLine
from app.schemas.reference import Alignment
from app.services import reference_service as service
from app.services.acoustics import engine, sources
from app.services.acoustics.audio import AudioFailure, crop, normalize
from app.workers.acoustic_worker import process

CONTENT = str(uuid4())
START = 120000


def wav_bytes(seconds=1):
    output = BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        wav.writeframes(b''.join(struct.pack('<h', int(6000 * math.sin(2 * math.pi * 220 * n / 16000))) for n in range(int(seconds * 16000))))
    return output.getvalue()


class MemoryRepository:
    """Test double only; production transitions are atomic Postgres functions."""
    def __init__(self):
        self.rows, self.audio, self.available, self.on_upload = {}, {}, True, None

    def source_available(self, owner, content):
        return self.available and content == CONTENT

    def get(self, owner, identifier):
        row = self.rows.get(identifier)
        return deepcopy(row) if row and row['user_id'] == owner else None

    def create(self, row):
        self.rows.setdefault(row['id'], {**deepcopy(row), 'audio_ready': False, 'results': [], 'attempts': 0,
                                        'created_at': datetime.now(timezone.utc).isoformat(), 'error_code': None})
        return self.get(row['user_id'], row['id'])

    def control(self, owner, identifier, action, digest=None):
        row = self.rows[identifier]
        if row['user_id'] != owner: return None
        if action == 'delete': row.update(state='deleted', audio_ready=False, results=[], snapshot={})
        elif row['state'] != 'deleted':
            if action == 'upload' and row['state'] == 'awaiting_upload': row.update(state='queued', audio_ready=True, audio_sha256=digest)
            elif action == 'cancel': row['state'] = 'cancelled'
            elif action == 'retry' and row['state'] in ('failed', 'cancelled', 'partially_completed'):
                row['state'] = 'queued' if row['input_mode'] == 'file' or row['audio_ready'] else 'awaiting_upload'
        return deepcopy(row)

    def upload(self, row, data):
        self.audio[row['id']] = data
        if self.on_upload: self.on_upload(row)

    def read_audio(self, row): return self.audio[row['id']]
    def remove_audio(self, row): self.audio.pop(row['id'], None)

    def fenced(self, identifier, token, action, data=None):
        row = self.rows[identifier]
        if row['state'] != 'processing' or token != row.get('lease_token'): return False
        if action == 'audio': row.update(audio_ready=True, audio_sha256=data['sha256'])
        if action == 'results': row['results'] = data['results']
        if action == 'finish': row.update(state=data['state'], error_code=data.get('error_code'))
        return True


@pytest.fixture
def setup(monkeypatch, tmp_path):
    monkeypatch.setattr(service, 'get_settings', lambda: Settings(_env_file=None))
    monkeypatch.setattr('app.routers.references.get_settings', lambda: Settings(_env_file=None))
    data = wav_bytes(); source = tmp_path / 'source.wav'; source.write_bytes(data)
    grant = sources.SourceGrant(id='test', content_id=CONTENT, owners=['alice'], rights_reference='test-synthetic',
        expires_at=datetime.now(timezone.utc)+timedelta(days=2), origin_ms=START, end_ms=START+1000,
        sha256=sha256(data).hexdigest(), path=str(source), size=len(data))
    monkeypatch.setattr(sources, 'grants', lambda: [grant])
    line = TranscriptLine(id='sentence-v3-test', time='2:00', parts=['Hello hello.'], start_ms=START, end_ms=START+1000,
        segmentation_version='sentence-v3', source_token_start=0, source_token_end=2)
    blueprint = Blueprint(id=str(uuid4()), content_id=CONTENT, title='Synthetic', summary='', logic_flow=[], key_points=[],
        scenario_suggestions=[], transcript=[line], segments=[BlueprintSegment(id='segment', title='Test', summary='',
        start_ms=START, end_ms=START+1000, transcript_start_index=0, transcript_end_index=1)])
    monkeypatch.setattr(service, 'get_blueprint', lambda _: blueprint)
    repo = MemoryRepository()
    app.dependency_overrides[repository] = lambda: repo
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id='alice')
    yield TestClient(app), repo, grant, blueprint, data
    app.dependency_overrides.clear()


def prepare(client):
    response = client.post('/api/references', json={'content_id': CONTENT, 'segment_id': 'segment'})
    assert response.status_code == 202, response.text
    return response.json()


def test_idempotent_snapshot_and_no_private_metadata(setup):
    client, repo, _, _, _ = setup
    first = prepare(client)
    assert prepare(client)['id'] == first['id']
    assert first['start_ms'] == START and first['state'] == 'queued'
    assert not {'snapshot', 'source_id', 'user_id', 'input_sha256'} & first.keys()
    assert repo.rows[first['id']]['snapshot']['sentences'][0]['id'] == 'sentence-v3-test'
    assert len(repo.rows) == 1


def test_no_source_permission_and_revocation(setup):
    client, repo, grant, _, _ = setup
    row = prepare(client); grant.owners = ['bob']
    assert client.get('/api/references/capability', params={'content_id': CONTENT, 'segment_id': 'segment'}).json()['available'] is False
    assert client.post('/api/references', json={'content_id': CONTENT, 'segment_id': 'segment'}).status_code == 409
    assert client.get('/api/references/' + row['id']).status_code == 403
    assert client.delete('/api/references/' + row['id']).status_code == 204


def test_all_routes_require_owner_and_verified_identity(setup):
    client, repo, _, _, _ = setup
    row = prepare(client); path = '/api/references/' + row['id']
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id='bob')
    for method, suffix in [('get',''), ('get','/audio'), ('put','/audio'), ('post','/retry'), ('post','/cancel'), ('delete','')]:
        assert getattr(client, method)(path + suffix).status_code == 404
    app.dependency_overrides.pop(require_user)
    assert client.get(path).status_code == 401
    assert len(repo.rows) == 1


def test_source_and_snapshot_validation(setup):
    client, repo, _, blueprint, _ = setup
    repo.available = False
    assert client.post('/api/references', json={'content_id': CONTENT, 'segment_id': 'segment'}).status_code == 404
    repo.available = True; blueprint.transcript[0].end_ms += 1
    assert client.post('/api/references', json={'content_id': CONTENT, 'segment_id': 'segment'}).status_code == 409
    assert client.post('/api/references', json={'content_id': CONTENT, 'segment_id': 'segment', 'user_id': 'bob'}).status_code == 422


def test_registered_upload_decode_replay_and_delete(setup):
    client, repo, grant, _, data = setup
    grant.mode='upload'; grant.path=None
    row=prepare(client); path='/api/references/'+row['id']
    assert row['state']=='awaiting_upload'
    assert client.put(path+'/audio',content=b'forged').status_code==422
    assert client.put(path+'/audio',content=data).json()['state']=='queued'
    assert client.put(path+'/audio',content=data).status_code==200
    audio=client.get(path+'/audio',params={'sentence_id':'sentence-v3-test'})
    assert audio.status_code==200 and audio.content.startswith(b'RIFF')
    assert audio.headers['cache-control']=='private, no-store'
    assert client.get(path+'/audio',params={'sentence_id':'wrong'}).status_code==404
    assert client.delete(path).status_code==204 and not repo.audio
    assert client.get(path).status_code==410
    assert client.post('/api/references',json={'content_id':CONTENT,'segment_id':'segment'}).status_code==410


def test_delete_wins_inflight_upload(setup):
    client, repo, grant, _, data=setup
    grant.mode='upload'; grant.path=None
    row=prepare(client); path='/api/references/'+row['id']
    repo.on_upload=lambda r:repo.control('alice',r['id'],'delete')
    assert client.put(path+'/audio',content=data).status_code==410 and not repo.audio


def test_duration_mismatch_rejects_even_authorized_hash(setup):
    client,_,grant,_,_=setup
    grant.mode='upload'; grant.path=None
    data=wav_bytes(.5); grant.sha256=sha256(data).hexdigest(); grant.size=len(data)
    row=prepare(client)
    assert client.put('/api/references/'+row['id']+'/audio',content=data).status_code==422


def test_expiry_and_cache_identity(setup):
    client,repo,grant,blueprint,_=setup
    row=prepare(client); blueprint.transcript[0].parts=['A changed transcript.']; other=prepare(client)
    assert row['id'] != other['id']
    repo.rows[other['id']]['expires_at']=(datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat()
    assert client.get('/api/references/'+other['id']).status_code==410


def test_storage_failure_safe_and_no_fallback(setup,monkeypatch):
    client,repo,_,_,_=setup
    app.dependency_overrides.pop(repository)
    monkeypatch.setattr('app.routers.references.get_reference_repository',lambda:None)
    assert client.post('/api/references',json={'content_id':CONTENT,'segment_id':'segment'}).status_code==503
    monkeypatch.setattr('app.routers.references.get_reference_repository',lambda:repo)
    monkeypatch.setattr(repo,'create',lambda _:(_ for _ in ()).throw(httpx.ConnectError('secret provider error')))
    response=client.post('/api/references',json={'content_id':CONTENT,'segment_id':'segment'})
    assert response.status_code==503 and 'secret' not in response.text


def test_actual_decode_crop_and_nonzero_timeline(tmp_path):
    source=tmp_path/'source.wav'; source.write_bytes(wav_bytes(2))
    normalized=tmp_path/'normal.wav'; normalize(source,normalized,500,1000)
    target=tmp_path/'crop.wav'; origin=crop(normalized,target,.1234,.7234)
    assert origin==round(.1234*16000)/16000
    with wave.open(str(target)) as wav: assert wav.getnframes()==9600 and wav.getframerate()==16000 and wav.getnchannels()==1
    with pytest.raises(AudioFailure): normalize(source,tmp_path/'bad.wav',0,3000)


def test_alignment_repeated_words_offsets_and_abstention():
    fixture={'tiers':{'words':{'entries':[[0,.2,'hello'],[.3,.5,'hello']]},'phones':{'entries':[[0,.1,'h'],[.1,.2,'e'],[.3,.5,'o']]}}}
    result=engine.parse_alignment(fixture,'Hello hello.',2.8,.6)
    assert result.words[0].start_sec==2.8 and result.words[-1].end_sec==3.3 and result.content_gate=='not_checked'
    with pytest.raises(ValueError): engine.parse_alignment(fixture,'Hello world.',2.8,.6)
    with pytest.raises(ValueError): engine.parse_alignment(fixture,'Hello hello.',2.8,.3)
    assert engine.align(Path('unused'),'hello',0,Path('unused'),Settings(_env_file=None)).status=='unavailable'


def test_real_pitch_and_vad_measurements(tmp_path):
    pytest.importorskip('parselmouth'); pytest.importorskip('onnxruntime')
    source=tmp_path/'source.wav'; source.write_bytes(wav_bytes())
    frames,speech,samples=engine.extract(source,Settings(_env_file=None))
    valid=[f.f0_hz for f in frames if f.f0_hz is not None]
    assert valid and abs(sum(valid)/len(valid)-220)<4
    measured=engine.sentence_measurements(frames,speech,samples,0,1)
    assert measured.duration_sec==1 and measured.rms_dbfs<0 and 'confidence' not in measured.model_dump()


def test_worker_partial_without_inventing_alignment(setup,monkeypatch):
    pytest.importorskip('parselmouth'); pytest.importorskip('onnxruntime')
    client,repo,_,_,_=setup
    result=prepare(client); row=repo.rows[result['id']]; row.update(state='processing',lease_token='token')
    monkeypatch.setattr(engine,'align',lambda *args:Alignment(status='unavailable',reason='mfa_not_configured'))
    process(repo,deepcopy(row),'token',Settings(_env_file=None))
    current=repo.rows[row['id']]
    assert current['audio_ready'] and current['state']=='partially_completed'
    assert current['results'][0]['observations']==[] and current['results'][0]['alignment']['phones']==[]


def test_worker_delete_fences_audio_and_cleans_object(setup):
    client,repo,_,_,_=setup
    result=prepare(client); row=repo.rows[result['id']]; row.update(state='processing',lease_token='token')
    repo.on_upload=lambda r:repo.control('alice',r['id'],'delete')
    process(repo,deepcopy(row),'token',Settings(_env_file=None))
    assert repo.rows[row['id']]['state']=='deleted' and not repo.audio


def test_event_stream_reads_durable_state_and_checks_owner(setup):
    client,repo,_,_,_=setup
    result=prepare(client);row=repo.rows[result['id']];row['state']='completed'
    path='/api/references/'+result['id']+'/events'
    response=client.get(path)
    assert response.status_code==200 and response.headers['content-type'].startswith('text/event-stream')
    assert 'event: reference' in response.text and '"state":"completed"' in response.text
    app.dependency_overrides[require_user]=lambda:AuthenticatedUser(id='bob')
    assert client.get(path).status_code==404


def capture_payload(data):
    return {'content_id': CONTENT, 'segment_id': 'segment', 'sentence_id': 'sentence-v3-test',
            'capture_id': 'browser-capture-1', 'start_ms': START, 'end_ms': START+1000,
            'sha256': sha256(data).hexdigest(), 'size': len(data), 'consent_version': 'reference-analysis-v1'}


@pytest.fixture
def captured(setup, monkeypatch):
    settings = Settings(_env_file=None, practice_asr_model_path='/fixture/model', practice_asr_model_sha256='a'*64)
    monkeypatch.setattr(service, 'get_settings', lambda: settings)
    monkeypatch.setattr(sources, 'grants', lambda: [])
    client, repo, _, blueprint, data = setup
    repo.recent_captures = lambda owner, content, segment: [deepcopy(r) for r in repo.rows.values()
        if r['user_id'] == owner and r['state'] != 'deleted']
    return client, repo, blueprint, data, settings


def test_browser_capture_without_file_grant_upload_and_recovery(captured):
    client, repo, blueprint, data, _ = captured
    payload = capture_payload(data)
    first = client.post('/api/references/captures', json=payload)
    assert first.status_code == 202, first.text
    row = first.json(); assert row['source_kind'] == 'browser_capture' and row['state'] == 'awaiting_upload'
    assert client.post('/api/references/captures', json=payload).json()['id'] == row['id']
    path = '/api/references/'+row['id']
    assert client.put(path+'/audio', content=data).json()['state'] == 'queued'
    assert client.get(path+'/audio', params={'sentence_id':'sentence-v3-test'}).content.startswith(b'RIFF')
    query = {'content_id': CONTENT, 'segment_id': 'segment', 'sentence_id': 'sentence-v3-test'}
    assert client.get('/api/references/captures/latest', params=query).json()['id'] == row['id']
    blueprint.transcript[0].parts = ['Changed words.']
    assert client.get('/api/references/captures/latest', params=query).json() is None
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id='bob')
    assert client.get(path).status_code == 404
    assert client.get('/api/references/captures/latest', params=query).json() is None


def test_browser_capture_rejects_wrong_timing_hash_and_duration(captured):
    client, repo, _, data, _ = captured
    payload = capture_payload(data)
    assert client.post('/api/references/captures', json={**payload, 'start_ms': START+1}).status_code == 409
    assert client.post('/api/references/captures', json={**payload, 'consent_version':'wrong'}).status_code == 422
    row = client.post('/api/references/captures', json=payload).json()
    assert client.put('/api/references/'+row['id']+'/audio', content=b'other').status_code == 422
    short = wav_bytes(.5)
    row = client.post('/api/references/captures', json=capture_payload(short)).json()
    assert client.put('/api/references/'+row['id']+'/audio', content=short).status_code == 422


def test_browser_capture_content_gate_runs_before_forced_alignment(captured, monkeypatch):
    import numpy as np
    from app.workers import acoustic_worker
    from app.schemas.reference import Measurements
    client, repo, _, data, settings = captured
    row = client.post('/api/references/captures', json=capture_payload(data)).json()
    client.put('/api/references/'+row['id']+'/audio', content=data)
    row = repo.rows[row['id']]; row.update(state='processing', lease_token='token')
    monkeypatch.setattr(engine, 'extract', lambda *args: ([], [], np.zeros(16000)))
    monkeypatch.setattr(engine, 'sentence_measurements', lambda *args: Measurements(duration_sec=1, rms_dbfs=-20, f0_valid_fraction=.8, clipping_fraction=0, frames=[], speech=[], pauses=[], quality_issues=[]))
    monkeypatch.setattr(acoustic_worker, 'transcribe', lambda *args: {'text':'Completely different words','reliable':True})
    monkeypatch.setattr(engine, 'align', lambda *args: pytest.fail('Mismatched reference must not be forced into expected text'))
    process(repo, deepcopy(row), 'token', settings)
    result = repo.rows[row['id']]
    assert result['state'] == 'partially_completed'
    assert result['results'][0]['prosody']['content']['status'] == 'mismatch'
    assert result['results'][0]['prosody']['words'] == []


def test_cached_reference_word_times_are_relative_to_sentence_not_segment(setup, monkeypatch):
    import numpy as np
    from app.workers import acoustic_worker
    from app.schemas.reference import Measurements, Interval
    client, repo, _, blueprint, _ = setup
    settings=Settings(_env_file=None,practice_asr_model_path='/fixture/model',practice_asr_model_sha256='a'*64)
    monkeypatch.setattr(service,'get_settings',lambda:settings)
    blueprint.transcript[0].start_ms=START+200
    result=prepare(client);row=repo.rows[result['id']];row.update(state='processing',lease_token='token')
    monkeypatch.setattr(engine,'extract',lambda *args:([],[],np.zeros(16000)))
    monkeypatch.setattr(engine,'sentence_measurements',lambda *args:Measurements(duration_sec=.8,rms_dbfs=-20,
        f0_valid_fraction=.8,clipping_fraction=0,frames=[],speech=[],pauses=[],quality_issues=[]))
    monkeypatch.setattr(acoustic_worker,'transcribe',lambda *args:{'text':'Hello hello.','reliable':True})
    monkeypatch.setattr(engine,'align',lambda wav,text,origin,*args:Alignment(status='aligned',
        words=[Interval(start_sec=origin,end_sec=origin+.3,label='hello'),Interval(start_sec=origin+.4,end_sec=origin+.7,label='hello')],phones=[]))
    process(repo,deepcopy(row),'token',settings)
    result=repo.rows[row['id']]
    assert result['state']=='completed'
    words=result['results'][0]['prosody']['words']
    assert words[0]['start_sec']==0 and words[1]['start_sec']==pytest.approx(.4)
    assert result['results'][0]['alignment']['words'][0]['start_sec']==.2
