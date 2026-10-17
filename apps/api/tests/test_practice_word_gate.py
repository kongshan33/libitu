from copy import deepcopy
from hashlib import sha256
from types import SimpleNamespace

import pytest

from app.schemas.practice_analysis import ContentCheck, GATED_ANALYSIS_VERSION, VoiceProsody, WordProsody
from app.services.acoustics.word_check import check_words, content_check
from app.workers import practice_analysis_worker as worker


@pytest.fixture
def gated(monkeypatch):
    settings = SimpleNamespace(acoustic_lease_seconds=60, practice_asr_model_sha256='model')
    row = dict(id='take', user_id='owner', reference_id=None, analysis_version=GATED_ANALYSIS_VERSION,
        snapshot={'engine': {}, 'asr_sha256': 'model', 'text': 'one two three four five', 'sentence_id': 's'},
        input_bytes=3, input_sha256=sha256(b'ogg').hexdigest(), phase='queued_word_check', word_check=None, learner_checkpoint=None)
    writes, calls = [], []
    def fenced(identifier, token, action, data):
        writes.append((identifier, token, action, deepcopy(data)))
        if action in ('checkpoint','publish_handoff'):
            row.update(deepcopy(data))
        return True
    repo = SimpleNamespace(get_attempt=lambda *args: {'start_ms': 1000, 'end_ms': 2000},
        read_audio=lambda _: b'ogg', fenced=fenced)
    monkeypatch.setattr(worker.engine, 'engine_identity', lambda _: {})
    monkeypatch.setattr(worker, 'normalize_take', lambda *args: 1)
    monkeypatch.setattr(worker, 'reference_for', lambda *args: None)
    def check(*args):
        calls.append('asr')
        return check_words(row['snapshot']['text'], {'text': row.get('recognized', row['snapshot']['text']), 'reliable': row.get('reliable', True)})
    def analyze(audio, check, scope, *args):
        assert row['word_check'] is not None, 'Publish the word check before measurements'
        calls.append(scope)
        mapping = {op.recognized_index: op.source_index for op in check.operations if op.kind == 'matched'}
        return VoiceProsody(content=content_check(check), alignment_status='aligned',
            words=[WordProsody(text=t.normalized, start_sec=i*.3, end_sec=(i+1)*.3, duration_ms=300,
                recognized_index=i, source_index=mapping.get(i), pitch_curve_st=[0]*5 if scope == 'all_layers' else [])
                for i, t in enumerate(check.recognized_tokens)])
    monkeypatch.setattr(worker, 'check_learner_words', check)
    monkeypatch.setattr(worker, 'analyze_checked_voice', analyze)
    return repo, row, settings, writes, calls


@pytest.mark.parametrize('actual,tier,scope', [
    ('one two xx yy zz', 'below_60', None),
    ('one two three xx yy', 'partial_60_85', 'sound_only'),
    ('one two three four five', 'full_85_plus', 'all_layers'),
])
def test_worker_runs_only_the_eligible_scope(gated, actual, tier, scope):
    repo, row, settings, writes, calls = gated
    row['recognized'] = actual
    worker.process(repo, row, 'lease', settings)
    assert row['word_check']['tier'] == tier
    assert calls == ['asr'] + ([scope] if scope else [])
    assert writes[-1][2] == 'finish' and writes[-1][3]['state'] == 'completed'
    assert writes[-1][3]['result']['version'] == GATED_ANALYSIS_VERSION
    if not scope:
        assert writes[-1][3]['result']['assessment'] is None
        assert writes[-1][3]['result']['learner']['words'] == []
    elif scope == 'sound_only':
        assessment = writes[-1][3]['result']['assessment']
        assert assessment['rhythm']['value'] is assessment['melody']['value'] is None
        assert assessment['rhythm']['reason'] == 'match_threshold_not_met'


def test_uncertain_recognition_has_no_scope_and_no_false_omissions(gated):
    repo, row, settings, writes, calls = gated
    row['reliable'] = False
    worker.process(repo, row, 'lease', settings)
    assert calls == ['asr']
    assert row['word_check']['tier'] is None and row['word_check']['operations'] == []
    assert writes[-1][3]['state'] == 'needs_review'


def test_low_match_finishes_even_when_reference_is_pending(gated, monkeypatch):
    repo, row, settings, writes, calls = gated
    row['recognized'] = 'one xx yy zz aa'
    monkeypatch.setattr(worker, 'reference_for', lambda *args: pytest.fail('Low match must not wait for reference'))
    worker.process(repo, row, 'lease', settings)
    assert calls == ['asr'] and writes[-1][2] == 'finish'


@pytest.mark.parametrize('actual,scope', [('one two three xx yy', 'sound_only'),
                                          ('one two three four five', 'all_layers')])
def test_reference_wait_saves_acoustics_then_resumes_without_audio(gated, monkeypatch, actual, scope):
    repo, row, settings, writes, calls = gated
    row['reference_id'] = 'ref'
    row['recognized'] = actual
    monkeypatch.setattr(worker, 'reference_for', lambda *args: {'state': 'processing', 'audio_ready': False})
    worker.process(repo, row, 'lease1', settings)
    assert row['learner_checkpoint']['alignment_status'] == 'aligned'
    assert calls == ['asr', scope] and writes[-1][2] == 'wait_reference'
    repo.read_audio = lambda *_: pytest.fail('Resume must use checkpoints without downloading audio')
    monkeypatch.setattr(worker, 'normalize_take', lambda *_: pytest.fail('No second decode'))
    worker.process(repo, row, 'lease_pending', settings)
    assert calls == ['asr', scope] and writes[-1][2] == 'wait_reference'
    monkeypatch.setattr(worker, 'reference_for', lambda *args: {'state': 'failed', 'audio_ready': False})
    worker.process(repo, row, 'lease2', settings)
    assert calls == ['asr', scope] and writes[-1][2] == 'finish'


def test_downstream_failure_reuses_both_durable_checkpoints(gated, monkeypatch):
    repo, row, settings, writes, calls = gated
    original = worker.assess_checked
    monkeypatch.setattr(worker, 'assess_checked', lambda *args: (_ for _ in ()).throw(RuntimeError('assessment failed')))
    worker.process(repo, row, 'lease1', settings)
    assert writes[-1][3]['error_code'] == 'analysis_failed'
    assert row['word_check'] and row['learner_checkpoint']
    monkeypatch.setattr(worker, 'assess_checked', original)
    worker.process(repo, row, 'lease2', settings)
    assert calls == ['asr', 'all_layers'] and writes[-1][3]['state'] == 'completed'


def test_lost_checkpoint_lease_cannot_continue_into_analysis(gated):
    repo, row, settings, writes, calls = gated
    repo.fenced = lambda *args: False
    worker.process(repo, row, 'lease', settings)
    assert calls == [] and writes == []


@pytest.mark.parametrize('basis', ['matched', 'source_transcript'])
def test_reference_cache_pairs_partial_take_by_positions_without_reinfer(gated, monkeypatch, basis):
    repo, row, settings, writes, calls = gated
    row['recognized'] = 'one two three xx yy'
    reference_voice = VoiceProsody(content=ContentCheck(status=basis), alignment_status='aligned',
        words=[WordProsody(text=t, start_sec=i*.3, end_sec=(i+1)*.3, duration_ms=300)
               for i, t in enumerate(row['snapshot']['text'].split())])
    reference = {'state': 'completed', 'audio_ready': True, 'snapshot': {
        'source_kind': 'browser_capture', 'engine': {}, 'asr_sha256': 'model'},
        'results': [{'sentence_id': 's', 'prosody': reference_voice.model_dump()}]}
    if basis == 'source_transcript':
        reference['snapshot'].pop('asr_sha256')
        reference['snapshot']['reference_pipeline'] = 'reference-source-transcript-v2'
    monkeypatch.setattr(worker, 'reference_for', lambda *args: reference)
    monkeypatch.setattr(worker, 'get_reference_repository', lambda: pytest.fail('Must reuse cached prosody'))
    worker.process(repo, row, 'lease', settings)
    result = writes[-1][3]['result']
    assert result['comparison'] == 'available'
    assert [w['source_index'] for w in result['learner']['words']] == [0, 1, 2, None, None]
    assert result['assessment']['rhythm']['value'] is None


def test_reference_revocation_strips_gated_comparison(gated, monkeypatch):
    repo, row, settings, writes, calls = gated
    reference_voice = VoiceProsody(content=ContentCheck(status='matched'), alignment_status='aligned',
        words=[WordProsody(text=t, start_sec=i*.3, end_sec=(i+1)*.3, duration_ms=300)
               for i, t in enumerate(row['snapshot']['text'].split())])
    reference = {'state': 'completed', 'audio_ready': True, 'snapshot': {'source_kind': 'browser_capture', 'engine': {}, 'asr_sha256': 'model'},
        'results': [{'sentence_id': 's', 'prosody': reference_voice.model_dump()}]}
    checks = iter([reference, None])
    monkeypatch.setattr(worker, 'reference_for', lambda *args: next(checks))
    worker.process(repo, row, 'lease', settings)
    assert writes[-1][3]['result']['reference'] is None
    assert writes[-1][3]['result']['comparison'] == 'unavailable'


def test_reference_status_is_read_after_acoustic_checkpoint(gated, monkeypatch):
    repo, row, settings, writes, calls = gated
    def reference(*args):
        assert row['learner_checkpoint'], 'Reference may finish while learner runs; read current state'
        return {'state': 'failed', 'audio_ready': False}
    monkeypatch.setattr(worker, 'reference_for', reference)
    worker.process(repo, row, 'lease', settings)
    assert writes[-1][2] == 'finish'


def test_unusable_learner_does_not_wait_for_reference(gated, monkeypatch):
    repo, row, settings, writes, calls = gated
    monkeypatch.setattr(worker, 'analyze_checked_voice', lambda *args:
        VoiceProsody(content=ContentCheck(status='matched'), alignment_status='unavailable'))
    monkeypatch.setattr(worker, 'reference_for', lambda *args: {'state': 'processing', 'audio_ready': False})
    worker.process(repo, row, 'lease', settings)
    assert writes[-1][2] == 'finish' and writes[-1][3]['state'] == 'needs_review'


def test_lost_learner_checkpoint_cannot_wait_or_publish(gated, monkeypatch):
    repo, row, settings, writes, calls = gated
    original = repo.fenced
    repo.fenced = lambda identifier, token, action, data: (False if 'learner_checkpoint' in data
        else original(identifier, token, action, data))
    monkeypatch.setattr(worker, 'reference_for', lambda *args: pytest.fail('Lease lost before comparison'))
    worker.process(repo, row, 'lease', settings)
    assert calls == ['asr', 'all_layers']
    assert all(action not in ('wait_reference', 'finish') for _, _, action, _ in writes)


def test_progressive_checkpoint_precedes_mfa_and_retries_without_reextract(gated, monkeypatch):
    from test_signal_prosody import evidence
    repo,row,settings,writes,calls=gated
    row['snapshot']['progressive_version']='server-prominence-v1'
    measured=evidence()
    monkeypatch.setattr(worker.engine,'extract',lambda *args: ([],[],[0]*32000))
    monkeypatch.setattr(worker.engine,'sentence_measurements',lambda *args: measured)
    def fine(*args,measurements):
        assert measurements==measured
        assert row['coarse_checkpoint']['boundary_source']=='asr_word'
        assert len(row['acoustic_checkpoint']['frames'])==200
        raise RuntimeError('MFA interrupted')
    monkeypatch.setattr(worker,'analyze_checked_voice',fine)
    worker.process(repo,row,'first',settings)
    assert writes[-1][3]['state']=='failed' and row['phase']=='coarse_ready'
    assert row['coarse_checkpoint']['prominence']
    monkeypatch.setattr(worker.engine,'extract',lambda *args:pytest.fail('Must reuse full frames'))
    monkeypatch.setattr(worker,'check_learner_words',lambda *args:pytest.fail('Must reuse word check'))
    monkeypatch.setattr(worker,'analyze_checked_voice',lambda *args,**kwargs:VoiceProsody(content=content_check(check_words(row['snapshot']['text'],{'text':row['snapshot']['text'],'reliable':True})),alignment_status='unavailable'))
    worker.process(repo,row,'retry',settings)
    assert writes[-1][3]['state']=='needs_review'
    assert row['coarse_checkpoint']['prominence'] and len(row['acoustic_checkpoint']['frames'])==200


def test_progressive_publish_failure_stops_before_mfa(gated,monkeypatch):
    from test_signal_prosody import evidence
    repo,row,settings,writes,calls=gated;row['snapshot']['progressive_version']='server-prominence-v1'
    monkeypatch.setattr(worker.engine,'extract',lambda *args:([],[],[0]*32000))
    monkeypatch.setattr(worker.engine,'sentence_measurements',lambda *args:evidence())
    write=repo.fenced
    repo.fenced=lambda identifier,token,action,data: False if 'coarse_checkpoint' in data else write(identifier,token,action,data)
    monkeypatch.setattr(worker,'analyze_checked_voice',lambda *args,**kwargs:pytest.fail('Lost coarse lease must stop MFA'))
    worker.process(repo,row,'lease',settings)
    assert calls==['asr'] and writes[-1][3].get('acoustic_checkpoint')


@pytest.mark.parametrize('actual,tier', [('one two xx yy zz','below_60'),
    ('one two three xx yy','partial_60_85'),('one two three four five','full_85_plus')])
def test_fast_lane_never_runs_mfa_and_fine_reuses_checkpoint(gated,monkeypatch,actual,tier):
    from test_signal_prosody import evidence
    repo,row,settings,writes,calls=gated
    row['recognized']=actual
    row['snapshot']['progressive_version']='server-prominence-v1'
    measured=evidence()
    monkeypatch.setattr(worker.engine,'extract',lambda *_:([],[],[0]*32000))
    monkeypatch.setattr(worker.engine,'sentence_measurements',lambda *_:measured)
    def fine(*args,**kwargs):
        calls.append('fine')
        if tier=='full_85_plus': assert kwargs['measurements']==measured
        return VoiceProsody(content=ContentCheck(status='matched'),alignment_status='unavailable')
    monkeypatch.setattr(worker,'analyze_checked_voice',lambda *a,**kw:pytest.fail('Fast must not invoke MFA'))
    worker.process(repo,row,'fast',settings,lane='fast')
    assert row['word_check']['tier']==tier and calls==['asr']
    if tier=='below_60':
        assert writes[-1][2]=='finish'
        return
    assert writes[-1][2]=='publish_handoff' and row['learner_checkpoint'] is None
    if tier=='full_85_plus': assert row['coarse_checkpoint']['boundary_source']=='asr_word'
    else: assert 'acoustic_checkpoint' not in row
    monkeypatch.setattr(worker,'check_learner_words',lambda *_:pytest.fail('Fine cannot rerun ASR'))
    monkeypatch.setattr(worker.engine,'extract',lambda *_:pytest.fail('Fine must reuse full frames'))
    monkeypatch.setattr(worker,'analyze_checked_voice',fine)
    worker.process(repo,row,'fine',settings,lane='fine')
    assert calls==['asr','fine'] and writes[-1][2]=='finish'


def test_fine_missing_fast_checkpoint_fails_without_asr(gated,monkeypatch):
    repo,row,settings,writes,calls=gated
    monkeypatch.setattr(worker,'check_learner_words',lambda *_:pytest.fail('Do not silently rerun fast work'))
    worker.process(repo,row,'fine',settings,lane='fine')
    assert writes[-1][3]['error_code']=='fast_checkpoint_missing' and not calls


def test_paused_mfa_keeps_parent_lease_heartbeat(gated,monkeypatch,tmp_path):
    import sys
    import time
    from threading import Thread
    from app.services.acoustics import cpu_policy
    repo,row,settings,writes,calls=gated
    settings.acoustic_lease_seconds=.09
    row['recognized']='one two three xx yy'
    worker.process(repo,row,'fast',settings,lane='fast')
    lock=tmp_path/'fast.lock'
    monkeypatch.setenv(cpu_policy.LOCK_ENV,str(lock));monkeypatch.setenv(cpu_policy.YIELD_ENV,'1')
    def fine(*args,**kwargs):
        cpu_policy.run([sys.executable,'-c','import time; time.sleep(.1)'],capture_output=True,timeout=1,check=True)
        return VoiceProsody(content=ContentCheck(status='matched'),alignment_status='unavailable')
    monkeypatch.setattr(worker,'analyze_checked_voice',fine)
    thread=Thread(target=worker.process,args=(repo,row,'fine',settings),kwargs={'lane':'fine'})
    with cpu_policy.fast_activity(str(lock)):
        thread.start();time.sleep(.3)
        assert thread.is_alive()
        assert sum(action=='heartbeat' for _,_,action,_ in writes)>=3
        assert not any(action=='finish' for _,_,action,_ in writes)
    thread.join(3)
    assert not thread.is_alive() and writes[-1][2]=='finish'


@pytest.mark.parametrize('actual,scope', [('one two three xx yy','sound_only'), ('one two three four five','all_layers')])
def test_reference_free_take_completes_fast_then_fine(gated,monkeypatch,actual,scope):
    repo,row,settings,writes,calls=gated
    row['recognized']=actual
    worker.process(repo,row,'fast',settings,lane='fast')
    assert calls==['asr'] and writes[-1][2]=='publish_handoff'
    monkeypatch.setattr(worker,'check_learner_words',lambda *_:pytest.fail('Fine must reuse word check'))
    worker.process(repo,row,'fine',settings,lane='fine')
    assert calls==['asr',scope]
    assert not any(action=='wait_reference' for _,_,action,_ in writes)
    result=writes[-1][3]['result']
    assert writes[-1][3]['state']=='completed' and result['learner']['words']
    assert result['reference'] is None and result['comparison']=='unavailable'
    assert result['assessment']['rhythm']['value'] is result['assessment']['melody']['value'] is None
