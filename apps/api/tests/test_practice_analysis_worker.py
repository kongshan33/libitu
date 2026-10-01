from hashlib import sha256
from types import SimpleNamespace

import pytest

from app.schemas.practice_analysis import ANALYSIS_VERSION, ContentCheck, VoiceProsody, WordProsody
from app.workers import practice_analysis_worker as worker


@pytest.fixture
def processing(monkeypatch):
    settings = SimpleNamespace(acoustic_lease_seconds=60, practice_asr_model_sha256='model')
    row = dict(id='take', user_id='owner', reference_id=None, analysis_version=ANALYSIS_VERSION, snapshot={'engine': {}, 'asr_sha256': 'model', 'text': 'We practice.'},
        input_bytes=3, input_sha256=sha256(b'ogg').hexdigest())
    writes = []
    repo = SimpleNamespace(get_attempt=lambda *args: {'start_ms': 1000, 'end_ms': 2000}, read_audio=lambda _: b'ogg',
        fenced=lambda *args: writes.append(args) or True)
    monkeypatch.setattr(worker.engine, 'engine_identity', lambda _: {})
    monkeypatch.setattr(worker, 'normalize_take', lambda *args: 1)
    monkeypatch.setattr(worker, 'reference_for', lambda *args: None)
    voice = VoiceProsody(content=ContentCheck(status='matched', transcript='We practice.'), alignment_status='aligned',
        words=[WordProsody(text='we', start_sec=0, end_sec=.3, duration_ms=300)])
    monkeypatch.setattr(worker, 'analyze_voice', lambda *args: voice)
    return repo, row, settings, writes, voice


def test_persists_learner_measurements_without_inventing_reference(processing):
    repo, row, settings, writes, _ = processing
    worker.process(repo, row, 'lease', settings)
    assert writes[-1][:3] == ('take', 'lease', 'finish')
    result = writes[-1][3]
    assert result['state'] == 'completed'
    assert result['result']['learner']['words'][0]['duration_ms'] == 300
    assert result['result']['reference'] is None and result['result']['comparison'] == 'unavailable'


def test_content_mismatch_saves_reviewable_transcript_not_word_comparison(processing):
    repo, row, settings, writes, voice = processing
    voice.content = ContentCheck(status='mismatch', transcript='Another sentence')
    voice.alignment_status, voice.words = 'not_run', []
    worker.process(repo, row, 'lease', settings)
    assert writes[-1][3]['state'] == 'needs_review'
    assert writes[-1][3]['result']['learner']['words'] == []


def test_deleted_parent_and_changed_input_cannot_publish(processing):
    repo, row, settings, writes, _ = processing
    repo.get_attempt = lambda *args: {'deleted_at': 'now'}
    worker.process(repo, row, 'lease', settings)
    assert writes == []
    row['input_sha256'] = 'wrong'
    # A present, live attempt is required before even reading its private bytes.
    repo.get_attempt = lambda *args: {'deleted_at': None}
    worker.process(repo, row, 'lease', settings)
    assert writes[-1][3]['error_code'] == 'recording_integrity_failed'


def test_reference_revocation_during_processing_strips_comparison(processing, monkeypatch):
    repo, row, settings, writes, _ = processing
    row['reference_id'] = 'ref'
    reference = {'audio_ready': True, 'audio_sha256': sha256(b'ref').hexdigest(), 'start_ms': 1000}
    checks = iter([reference, None])
    monkeypatch.setattr(worker, 'reference_for', lambda *args: next(checks))
    monkeypatch.setattr(worker, 'get_reference_repository', lambda: SimpleNamespace(read_audio=lambda _: b'ref'))
    monkeypatch.setattr(worker, 'crop', lambda *args: None)
    worker.process(repo, row, 'lease', settings)
    result = writes[-1][3]['result']
    assert result['reference'] is None and result['comparison'] == 'unavailable'


def test_reference_pending_retries_instead_of_publishing_partial_comparison(processing, monkeypatch):
    repo, row, settings, writes, _ = processing
    monkeypatch.setattr(worker, 'reference_for', lambda *args: {'audio_ready': False})
    worker.process(repo, row, 'lease', settings)
    assert writes[-1][2] == 'retry' and writes[-1][3]['error_code'] == 'reference_not_ready'


def test_cleanup_cancels_expired_work_before_removing_bytes():
    operations = []
    rows = [{'id': 'done', 'user_id': 'u', 'state': 'completed'}, {'id': 'expired', 'user_id': 'u', 'state': 'processing'}]
    repo = SimpleNamespace(cleanup_candidates=lambda _: rows,
        control=lambda owner, identifier, action: operations.append((identifier, action)),
        remove_audio=lambda row: operations.append((row['id'], 'remove')),
        mark_clean=lambda row, _: operations.append((row['id'], 'clean')))
    worker.reconcile(repo)
    assert operations == [('done', 'remove'), ('done', 'clean'), ('expired', 'cancel'), ('expired', 'remove'), ('expired', 'clean')]


def test_old_analysis_version_is_never_silently_relabelled(processing):
    repo, row, settings, writes, _ = processing
    row['analysis_version'] = 'practice-prosody-v1'
    worker.process(repo, row, 'lease', settings)
    assert writes[-1][3] == {'state': 'failed', 'error_code': 'worker_version_mismatch'}


def test_verified_cached_reference_is_reused_without_audio_or_reinference(processing, monkeypatch):
    repo, row, settings, writes, voice = processing
    row['snapshot']['sentence_id'] = 's'
    reference = {'state':'completed', 'audio_ready':True, 'input_mode':'upload',
        'snapshot':{'source_kind':'browser_capture','consent_version':'reference-analysis-v1','engine':{},'asr_sha256':'model'},
        'results':[{'sentence_id':'s','prosody':voice.model_dump()}]}
    monkeypatch.setattr(worker,'reference_for',lambda *args:reference)
    monkeypatch.setattr(worker,'get_reference_repository',lambda:pytest.fail('Cached reference must not be downloaded or reanalyzed'))
    worker.process(repo,row,'lease',settings)
    result=writes[-1][3]['result']
    assert result['comparison']=='available' and result['reference']['words'][0]['duration_ms']==300
    reference['snapshot']['asr_sha256']='another-model'
    worker.process(repo,row,'lease',settings)
    assert writes[-1][3]['result']['comparison']=='unavailable'


def test_failed_reference_releases_learner_result(processing,monkeypatch):
    repo,row,settings,writes,_=processing
    monkeypatch.setattr(worker,'reference_for',lambda *args:{'state':'failed','audio_ready':False})
    worker.process(repo,row,'lease',settings)
    assert writes[-1][2]=='finish' and writes[-1][3]['state']=='completed'
    assert writes[-1][3]['result']['reference'] is None
