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

    def read_snapshot(self, owner, identifier):
        attempt = self.get_attempt(owner, identifier)
        if not attempt or attempt.get('deleted_at'):
            return None
        row = self.get(owner, identifier)
        reference = service.reference_for(attempt, row.get('reference_id')) if row else None
        if reference:
            reference = {'content_id': attempt['content_id'], 'input_mode': 'upload',
                'expires_at': (datetime.now(timezone.utc)+timedelta(days=1)).isoformat(), **reference,
                'snapshot': {'source_kind': 'browser_capture', 'consent_version': 'reference-analysis-v1',
                    'sentences': [{'id': attempt['sentence_id'], 'text': attempt['sentence_text'],
                        'start_ms': attempt['start_ms'], 'end_ms': attempt['end_ms']}], **reference.get('snapshot', {})}}
        return {'attempt': attempt, 'analysis': row, 'reference': reference}

    def create(self, row):
        self.row = {**deepcopy(row), 'created_at': datetime.now(timezone.utc).isoformat(),
            'input_expires_at': (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(), 'input_cleaned_at': None,
            'input_ready': False, 'result': None, 'error_code': None}
        return self.get('owner', ID)

    def mark_recognition_error(self, owner, identifier):
        attempt = self.get_attempt(owner, identifier)
        if not attempt or attempt.get('deleted_at'):
            return None
        if not self.attempt.get('recognition_feedback'):
            self.attempt['recognition_feedback'] = {'kind': 'recognition_error', 'created_at': datetime.now(timezone.utc).isoformat()}
        return deepcopy(self.attempt)

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
            self.row.update(state='deleted', result=None, snapshot={}, word_check=None, learner_checkpoint=None)
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


def retained_repository(repo):
    from test_practice import MemoryRepository
    from app.integrations.practice_repository import get_practice_repository
    recordings = MemoryRepository()
    recordings.rows[ID] = {**repo.attempt, 'recording_state': 'pending',
        'recording_sha256': sha256(DATA).hexdigest(), 'recording_bytes': len(DATA), 'recording_mime': 'audio/ogg',
        'reference_version': 'v1', 'duration_ms': 2000, 'playback_rate': 1, 'text_visible': True,
        'created_at': datetime.now(timezone.utc).isoformat()}
    app.dependency_overrides[get_practice_repository] = lambda: recordings
    return recordings


def test_single_upload_queues_analysis_before_saving_consented_recording(client):
    c, repo = client; recordings = retained_repository(repo)
    url = f'/api/practice/attempts/{ID}/analysis'
    assert c.post(url, json=payload()).status_code == 202
    recordings.on_upload = lambda _: assert_queued(repo)
    response = c.put(url+'/audio?retain_recording=true', content=DATA, headers={'Content-Type':'audio/ogg'})
    assert response.status_code == 200, response.text
    assert repo.audio == recordings.audio[ID] == DATA
    assert recordings.rows[ID]['recording_state'] == 'ready'


def assert_queued(repo):
    assert repo.row['state'] == 'queued', 'retention must not block analysis enqueue'


def test_retention_retry_does_not_recreate_cleaned_analysis_input(client):
    c, repo = client; recordings = retained_repository(repo)
    url = f'/api/practice/attempts/{ID}/analysis'
    c.post(url, json=payload()); recordings.fail_upload = True
    import httpx
    # This fixture replaces the repository dependency (and its HTTP error mapping).
    with pytest.raises(httpx.ConnectError):
        c.put(url+'/audio?retain_recording=true', content=DATA, headers={'Content-Type':'audio/ogg'})
    assert repo.row['state'] == 'queued'
    repo.row.update(state='completed', input_cleaned_at=datetime.now(timezone.utc).isoformat(), input_ready=False)
    repo.audio = None; recordings.fail_upload = False
    assert c.put(url+'/audio?retain_recording=true', content=DATA, headers={'Content-Type':'audio/ogg'}).status_code == 200
    assert repo.audio is None and repo.row['state'] == 'completed'
    assert recordings.audio[ID] == DATA


@pytest.mark.parametrize('state', ['none', 'deleted'])
def test_combined_upload_cannot_create_retention_consent(client, state):
    c, repo = client; recordings = retained_repository(repo)
    recordings.rows[ID]['recording_state'] = state
    url = f'/api/practice/attempts/{ID}/analysis'; c.post(url, json=payload())
    assert c.put(url+'/audio?retain_recording=true', content=DATA, headers={'Content-Type':'audio/ogg'}).status_code == 409
    assert repo.audio is None and not recordings.audio


def test_combined_upload_rejects_mismatched_purposes_before_writing(client):
    c, repo = client; recordings = retained_repository(repo)
    recordings.rows[ID]['recording_sha256'] = 'f'*64
    url = f'/api/practice/attempts/{ID}/analysis'; c.post(url, json=payload())
    assert c.put(url+'/audio?retain_recording=true', content=DATA, headers={'Content-Type':'audio/ogg'}).status_code == 422
    assert repo.audio is None and not recordings.audio


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


def test_intermediate_check_is_readable_without_final_result_or_reference(client, monkeypatch):
    from app.services.acoustics.word_check import check_words
    c, repo = client
    url = f'/api/practice/attempts/{ID}/analysis'
    c.post(url, json=payload())
    check = check_words('We practice.', {'text': 'We practice.', 'reliable': True})
    repo.row.update(state='queued', phase='word_check_complete', word_check=check.model_dump(), reference_id=str(uuid4()))
    monkeypatch.setattr(service, 'reference_for', lambda *args: {'state': 'processing'})
    data = c.get(url).json()
    assert data['result'] is None and data['word_check']['tier'] == 'full_85_plus'
    assert data['analysis_scope'] == 'all_layers'
    assert data['error_code'] is None  # Word-check checkpoint is separate from reference-wait reporting.
    repo.row['phase'] = 'waiting_reference'
    data = c.get(url).json()
    assert data['error_code'] == 'reference_pending'
    assert all(layer['state'] == 'pending' for layer in data['layers'].values())


def test_partial_gate_only_unlocks_sound_and_read_does_not_recheck(client):
    from app.services.acoustics.word_check import check_words
    c, repo = client
    url = f'/api/practice/attempts/{ID}/analysis'
    c.post(url, json=payload())
    repo.row.update(state='processing', phase='analyzing_sound', word_check=check_words(
        'one two three four five', {'text': 'one two three xx yy', 'reliable': True}).model_dump())
    data = c.get(url).json()
    assert data['layers']['sound']['state'] == 'pending'
    assert data['layers']['rhythm']['state'] == data['layers']['melody']['state'] == 'locked'
    assert data['analysis_scope'] == 'sound_only'


def test_legacy_analysis_read_has_no_invented_gate(client):
    c, repo = client
    url = f'/api/practice/attempts/{ID}/analysis'
    c.post(url, json=payload())
    repo.row.update(analysis_version='practice-comparison-v2', phase=None)
    data = c.get(url).json()
    assert data['word_check'] is data['analysis_scope'] is data['layers'] is None


def test_recognition_feedback_is_idempotent_and_never_changes_gate_or_analysis(client):
    from app.services.acoustics.word_check import check_words
    c, repo = client
    url = f'/api/practice/attempts/{ID}/analysis'
    c.post(url, json=payload())
    check = check_words('We practice.', {'text': 'We work.', 'reliable': True})
    repo.row.update(state='completed', phase='finished', word_check=check.model_dump())
    before = deepcopy(repo.row)
    feedback_url = f'/api/practice/attempts/{ID}/recognition-feedback'
    first = c.put(feedback_url, json={'kind': 'recognition_error'})
    assert first.status_code == 200
    assert c.put(feedback_url, json={'kind': 'recognition_error'}).json() == first.json()
    assert repo.row == before
    data = c.get(url).json()
    assert data['recognition_feedback'] == first.json()
    assert data['word_check']['tier'] == 'below_60' and data['analysis_scope'] == 'none'
    assert all(layer['state'] == 'locked' for layer in data['layers'].values())
    # The marker belongs to the take; deleting analysis does not resurrect it or remove the marker.
    c.delete(url)
    assert c.put(feedback_url, json={'kind': 'recognition_error'}).json() == first.json()
    assert repo.row['word_check'] is None


@pytest.mark.parametrize('actual,reliable', [('We practice.', True), ('We work.', False), ('', True)])
def test_feedback_requires_reliable_check_with_differences(client, actual, reliable):
    from app.services.acoustics.word_check import check_words
    c, repo = client
    url = f'/api/practice/attempts/{ID}/recognition-feedback'
    assert c.put(url, json={'kind': 'recognition_error'}).status_code == 409
    c.post(f'/api/practice/attempts/{ID}/analysis', json=payload())
    repo.row.update(word_check=check_words('We practice.', {'text': actual, 'reliable': reliable}).model_dump())
    assert c.put(url, json={'kind': 'recognition_error'}).status_code == 409
    assert repo.attempt.get('recognition_feedback') is None


def test_feedback_rejects_wrong_owner_deleted_take_and_forged_fields(client):
    from app.services.acoustics.word_check import check_words
    c, repo = client
    url = f'/api/practice/attempts/{ID}/recognition-feedback'
    c.post(f'/api/practice/attempts/{ID}/analysis', json=payload())
    repo.row['word_check'] = check_words('We practice.', {'text': 'We work.', 'reliable': True}).model_dump()
    for body in ({'kind': 'correct'}, {'kind': 'recognition_error', 'tier': 'full_85_plus'},
                 {'kind': 'recognition_error', 'created_at': '2020-01-01T00:00:00Z'}):
        assert c.put(url, json=body).status_code == 422
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id='someone-else')
    assert c.put(url, json={'kind': 'recognition_error'}).status_code == 404
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id='owner')
    repo.attempt['deleted_at'] = 'now'
    assert c.put(url, json={'kind': 'recognition_error'}).status_code == 404


def test_parent_deleted_between_feedback_check_and_write_is_not_resurrected(client):
    from app.services.acoustics.word_check import check_words
    c, repo = client
    c.post(f'/api/practice/attempts/{ID}/analysis', json=payload())
    repo.row['word_check'] = check_words('We practice.', {'text': 'We work.', 'reliable': True}).model_dump()
    def deleted(*args):
        repo.attempt['deleted_at'] = 'now'
        return None
    repo.mark_recognition_error = deleted
    assert c.put(f'/api/practice/attempts/{ID}/recognition-feedback', json={'kind': 'recognition_error'}).status_code == 404
    assert repo.attempt.get('recognition_feedback') is None


def test_coarse_view_pairs_only_compatible_live_reference_and_hides_raw_frames(client,monkeypatch):
    from test_signal_prosody import evidence, boundaries
    from app.services.acoustics.signal_prosody import analyze_signal
    from app.services.acoustics.word_check import check_words
    c,repo=client;url=f'/api/practice/attempts/{ID}/analysis'
    c.post(url,json=payload())
    signal=analyze_signal(evidence(),boundaries(),'asr_word').model_dump()
    repo.row.update(state='processing',phase='coarse_ready',coarse_checkpoint=signal,
        acoustic_checkpoint=evidence().model_dump(),word_check=check_words('We practice.',{'text':'We practice.','reliable':True}).model_dump(),reference_id=str(uuid4()))
    reference={'state':'processing','audio_ready':True,'snapshot':{'engine':repo.row['snapshot']['engine']},
        'results':[{'sentence_id':'s1','coarse':{**signal,'boundary_source':'subtitle_word'}}]}
    monkeypatch.setattr(service,'reference_for',lambda *args:reference)
    view=c.get(url).json()
    assert view['coarse']['reference']['boundary_source']=='subtitle_word'
    assert view['layers']['rhythm']['reason']=='preliminary' and view['layers']['sound']['state']=='pending'
    assert 'acoustic_checkpoint' not in view and 'frames' not in view['coarse']['learner']
    reference['snapshot']['engine']={}
    assert c.get(url).json()['coarse']['reference'] is None
    monkeypatch.setattr(service,'reference_for',lambda *args:None)
    assert c.get(url).json()['coarse']['learner']['prominence']
    assert c.get(url).json()['coarse']['reference'] is None
    repo.row['state']='deleted'
    assert c.get(url).json()['coarse'] is None
