from copy import deepcopy
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from app.auth import AuthenticatedUser, require_user
from app.main import app
from app.routers.practice_analysis import repository
from app.schemas.reference import Alignment, Frame, Interval, Measurements
from app.services import practice_analysis_service as service
from app.services.acoustics.practice_prosody import check_content, word_measurements

ID = str(uuid4())
DATA = b'OggSanalysis-test'


class Memory:
    def __init__(self):
        self.row = None
        self.audio = None
        self.after_upload = None
        self.attempt = dict(id=ID, user_id='owner', sentence_id='s1', sentence_text='We practice.',
            start_ms=1000, end_ms=3000, content_id=str(uuid4()), deleted_at=None)

    def get_attempt(self, owner, identifier):
        return deepcopy(self.attempt) if owner == 'owner' and identifier == ID else None

    def get(self, owner, identifier):
        return deepcopy(self.row) if owner == 'owner' and identifier == ID else None

    def create(self, row):
        self.row = {**deepcopy(row), 'created_at': datetime.now(timezone.utc).isoformat(),
            'input_expires_at': (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(), 'input_cleaned_at': None,
            'input_ready': False, 'result': None, 'error_code': None}
        return self.get('owner', ID)

    def upload(self, row, data):
        self.audio = data
        if self.after_upload:
            self.after_upload()

    def remove_audio(self, row):
        self.audio = None

    def control(self, owner, identifier, action):
        if owner != 'owner':
            return None
        if action == 'delete':
            self.row.update(state='deleted', result=None, snapshot={})
        elif self.row['state'] != 'deleted':
            if action == 'upload':
                self.row.update(state='queued', input_ready=True)
            elif action == 'cancel':
                self.row['state'] = 'cancelled'
            elif action == 'retry':
                self.row['state'] = 'queued' if self.row['input_ready'] else 'awaiting_upload'
        return self.get(owner, identifier)


@pytest.fixture
def client(monkeypatch):
    repo = Memory()
    settings = service.get_settings().model_copy(update={'practice_asr_model_path': '/test/model', 'practice_asr_model_sha256': 'a'*64})
    monkeypatch.setattr(service, 'get_settings', lambda: settings)
    app.dependency_overrides[repository] = lambda: repo
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id='owner')
    with TestClient(app) as client:
        yield client, repo
    app.dependency_overrides.clear()


def payload(**changes):
    return {'consent_version': 'practice-analysis-v1', 'sha256': sha256(DATA).hexdigest(),
        'size': len(DATA), 'mime_type': 'audio/ogg', 'reference_id': None, **changes}


def test_opt_in_upload_idempotency_and_no_implicit_recording_retention(client):
    c, repo = client
    assert c.get(f'/api/practice/attempts/{ID}/analysis').json() is None
    url = f'/api/practice/attempts/{ID}/analysis'
    assert c.post(url, json=payload()).status_code == 202
    assert repo.row['state'] == 'awaiting_upload'
    assert repo.audio is None
    assert c.post(url, json=payload()).status_code == 202
    assert c.post(url, json=payload(size=1)).status_code == 409
    response = c.put(url + '/audio', content=DATA, headers={'content-type': 'audio/ogg'})
    assert response.status_code == 200 and response.json()['state'] == 'queued'
    assert repo.audio == DATA
    assert 'recording_state' not in repo.attempt


@pytest.mark.parametrize('change', [{'consent_version': 'recording-retention-v1'}, {'user_id': 'victim'}, {'size': 8388609}, {'mime_type': 'text/plain'}])
def test_request_rejects_wrong_purpose_identity_and_unbounded_inputs(client, change):
    c, _ = client
    assert c.post(f'/api/practice/attempts/{ID}/analysis', json=payload(**change)).status_code == 422


def test_analysis_is_owner_scoped_and_attempt_deletion_wins(client):
    c, repo = client
    url = f'/api/practice/attempts/{ID}/analysis'
    c.post(url, json=payload())
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id='someone-else')
    for response in (c.get(url), c.post(url, json=payload()), c.delete(url), c.put(url+'/audio', content=DATA)):
        assert response.status_code == 404
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id='owner')
    repo.after_upload = lambda: repo.attempt.update(deleted_at='now')
    assert c.put(url+'/audio', content=DATA, headers={'content-type': 'audio/ogg'}).status_code == 409
    assert repo.audio is None
    assert c.get(url).status_code == 404


def test_delete_and_expiry_cannot_resurrect_audio(client):
    c, repo = client
    url = f'/api/practice/attempts/{ID}/analysis'
    c.post(url, json=payload())
    repo.row['input_expires_at'] = (datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat()
    assert c.put(url+'/audio', content=DATA, headers={'content-type': 'audio/ogg'}).status_code == 409
    assert c.post(url+'/retry').status_code == 409
    c.delete(url)
    assert repo.row['snapshot'] == {} and repo.row['result'] is None
    assert c.post(url, json=payload()).status_code == 409


def test_bad_bytes_and_mime_are_rejected(client):
    c, _ = client
    url = f'/api/practice/attempts/{ID}/analysis'
    c.post(url, json=payload())
    assert c.put(url+'/audio', content=b'wrong', headers={'content-type': 'audio/ogg'}).status_code == 422
    assert c.put(url+'/audio', content=DATA, headers={'content-type': 'audio/webm'}).status_code == 422


@pytest.mark.parametrize('text,asr,reliable,status', [
    ("We're ready.", "we’re ready", True, 'matched'),
    ('We are ready.', 'We were ready.', True, 'mismatch'),
    ('We are ready.', 'We are ready.', False, 'uncertain'),
    ('We are ready.', '', True, 'uncertain'),
    ('go go now', 'go now', True, 'mismatch'),
])
def test_independent_content_gate(text, asr, reliable, status):
    assert check_content(text, {'text': asr, 'reliable': reliable}).status == status


def test_word_prosody_uses_each_voice_clock_and_never_bridges_missing_pitch():
    alignment = Alignment(status='aligned', words=[Interval(start_sec=0, end_sec=.4, label='we'), Interval(start_sec=.7, end_sec=1, label='practice')])
    frames = [Frame(time_sec=i/100, f0_hz=100 if i<40 else None, energy_dbfs=-20) for i in range(100)]
    measurements = Measurements(duration_sec=1, rms_dbfs=-20, clipping_fraction=0, f0_valid_fraction=.4,
        frames=frames, speech=[], pauses=[Interval(start_sec=.4, end_sec=.7)], quality_issues=[])
    words = word_measurements(alignment, measurements)
    assert words[0].duration_ms == 400 and words[0].pause_after_ms == 300
    assert words[0].pitch_st == 0 and words[0].pitch_curve_st == [0]*5
    assert words[1].pitch_st is None and words[1].pitch_curve_st == [None]*5


def test_mismatch_does_not_run_forced_alignment(monkeypatch, tmp_path):
    from app.services.acoustics import practice_prosody as p
    measurement = SimpleNamespace(quality_issues=[])
    monkeypatch.setattr(p.engine, 'extract', lambda *args: ([], [], [0]*16000))
    monkeypatch.setattr(p.engine, 'sentence_measurements', lambda *args: measurement)
    monkeypatch.setattr(p, 'transcribe', lambda *args: {'text': 'A different sentence', 'reliable': True})
    monkeypatch.setattr(p.engine, 'align', lambda *args: pytest.fail('Mismatch must not be force-aligned to expected text'))
    result = p.analyze_voice(tmp_path/'audio.wav', 'We practice.', tmp_path, None)
    assert result.content.status == 'mismatch' and result.words == []


def test_reference_must_match_owner_sentence_version_and_range(monkeypatch):
    attempt = Memory().attempt
    reference = {'state': 'completed', 'content_id': attempt['content_id'], 'expires_at': (datetime.now(timezone.utc)+timedelta(days=1)).isoformat(),
        'snapshot': {'sentences': [{'id': 's1', 'text': 'Old sentence', 'start_ms': 1000, 'end_ms': 3000}]}}
    monkeypatch.setattr(service, 'get_reference_repository', lambda: SimpleNamespace(get=lambda owner, identifier: reference, source_available=lambda *args: True))
    monkeypatch.setattr(service.sources, 'resolve_row', lambda row: object())
    assert service.reference_for(attempt, 'ref') is None
    reference['snapshot']['sentences'][0]['text'] = 'We practice.'
    assert service.reference_for(attempt, 'ref') == reference


def test_reference_expiry_before_upload_does_not_block_learner_analysis(client, monkeypatch):
    c, repo = client
    monkeypatch.setattr(service, 'reference_for', lambda *args: None)
    request = payload(reference_id=str(uuid4()))
    url = f'/api/practice/attempts/{ID}/analysis'
    assert c.post(url, json=request).status_code == 202
    assert repo.row['reference_id'] is None
    assert c.post(url, json=request).status_code == 202


def test_unconfigured_model_does_not_accept_input_or_poison_job_identity(client, monkeypatch):
    c, repo = client
    settings = service.get_settings().model_copy(update={'practice_asr_model_sha256': None})
    monkeypatch.setattr(service, 'get_settings', lambda: settings)
    assert c.post(f'/api/practice/attempts/{ID}/analysis', json=payload()).status_code == 503
    assert repo.row is None and repo.audio is None


def test_reference_revocation_hides_nested_measurements_and_scores(client, monkeypatch):
    from app.schemas.practice_analysis import ContentCheck, LayerAssessment, ProsodyResult, VoiceProsody
    c, repo = client
    url = f'/api/practice/attempts/{ID}/analysis'
    c.post(url, json=payload())
    repo.row['reference_id'] = str(uuid4())
    voice = VoiceProsody(content=ContentCheck(status='matched'), alignment_status='aligned')
    repo.row['result'] = ProsodyResult(learner=voice,reference=voice,comparison='available',assessment=LayerAssessment()).model_dump()
    monkeypatch.setattr(service,'reference_for',lambda *args: None)
    result = c.get(url).json()['result']
    assert result['reference'] is None and result['assessment'] is None and result['comparison']=='unavailable'
