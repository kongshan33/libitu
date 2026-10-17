from pathlib import Path
import pytest
from app.config import Settings
from app.schemas.reference import Alignment, Interval, Measurements
from app.services.acoustics import engine
from app.services.acoustics.reference_prosody import align_reference, alignment_quality, compatible_reference, REFERENCE_PIPELINE


def measurements(**changes):
    return Measurements(duration_sec=1, rms_dbfs=-20, f0_valid_fraction=.8, clipping_fraction=0,
        frames=[], speech=[], pauses=[], quality_issues=[], **changes)


def aligned():
    words=[Interval(start_sec=.1,end_sec=.4,label='hello'),Interval(start_sec=.5,end_sec=.9,label='there')]
    return Alignment(status='aligned',words=words,phones=[w.model_copy(update={'label':'AH0'}) for w in words])


@pytest.mark.parametrize('issue', ['insufficient_speech','low_energy','clipping'])
def test_bad_audio_does_not_enter_mfa(issue, monkeypatch):
    monkeypatch.setattr(engine,'align',lambda *args:pytest.fail('Do not align bad audio'))
    m=measurements();m.quality_issues=[issue]
    alignment,voice=align_reference(Path('unused'),'hello there',0,m,Path('unused'),Settings(_env_file=None))
    assert alignment.reason=='insufficient_audio_quality'
    assert voice.content.status=='source_transcript' and not voice.words


@pytest.mark.parametrize('mutation', ['missing_word','missing_phones','phone_gap','overlap','out_of_bounds','short_word'])
def test_bad_alignment_is_withheld(mutation,monkeypatch):
    a=aligned()
    if mutation=='missing_word':a.words.pop()
    if mutation=='missing_phones':a.phones=[]
    if mutation=='phone_gap':a.phones[0].end_sec=.2
    if mutation=='overlap':a.words[1].start_sec=.3
    if mutation=='out_of_bounds':a.words[1].end_sec=1.2
    if mutation=='short_word':a.words[0].end_sec=.11
    monkeypatch.setattr(engine,'align',lambda *args:a)
    alignment,voice=align_reference(Path('unused'),'hello there',0,measurements(),Path('unused'),Settings(_env_file=None))
    assert alignment.status=='unavailable' and not voice.words


def test_missing_pitch_does_not_block_valid_word_alignment(monkeypatch):
    a=aligned();m=measurements();m.quality_issues=['insufficient_pitch']
    assert alignment_quality(a,'hello there',0,m) is None
    monkeypatch.setattr(engine,'align',lambda *args:a)
    alignment,voice=align_reference(Path('unused'),'hello there',0,m,Path('unused'),Settings(_env_file=None))
    assert alignment.status=='aligned' and len(voice.words)==2
    assert all(w.pitch_st is None for w in voice.words)


def test_reference_compatibility_checks_policy_and_engine_without_learner_asr_dependency():
    learner={'engine':{'model':'a'},'asr_sha256':'learner'}
    ref={'snapshot':{'engine':learner['engine'],'reference_pipeline':REFERENCE_PIPELINE}}
    assert compatible_reference(ref,learner)
    assert compatible_reference(ref,{**learner,'asr_sha256':'another'})
    assert not compatible_reference(ref,{**learner,'engine':{'model':'b'}})
    ref['snapshot']['reference_pipeline']='unknown'
    assert not compatible_reference(ref,learner)
    del ref['snapshot']['reference_pipeline']
    ref['snapshot']['asr_sha256']='learner'
    assert compatible_reference(ref,learner)
    assert not compatible_reference(ref,{**learner,'asr_sha256':'another'})


def test_unknown_dictionary_phone_remains_unavailable(monkeypatch,tmp_path):
    import json
    from hashlib import sha256
    from types import SimpleNamespace
    import wave
    model,dictionary=tmp_path/'model',tmp_path/'dictionary'
    model.write_bytes(b'model');dictionary.write_bytes(b'dictionary')
    binary=tmp_path/'mfa';binary.write_text('fixture')
    settings=Settings(_env_file=None,acoustic_mfa_model=str(model),acoustic_mfa_dictionary=str(dictionary),
        acoustic_mfa_binary=str(binary),
        acoustic_mfa_model_sha256=sha256(b'model').hexdigest(),acoustic_mfa_dictionary_sha256=sha256(b'dictionary').hexdigest())
    wav=tmp_path/'audio.wav'
    with wave.open(str(wav),'wb') as audio:
        audio.setparams((1,2,16000,0,'NONE','not compressed'));audio.writeframes(b'\0'*32000)
    def run(command,**kwargs):
        assert command[1]=='align_one', 'Sentence processing must not probe the MFA version'
        Path(command[6]).write_text(json.dumps({'tiers':{'words':{'entries':[[0,.5,'hello']]},'phones':{'entries':[[0,.5,'spn']]}}}))
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(engine.subprocess,'run',run)
    result=engine.align(wav,'hello',0,tmp_path/'alignment',settings)
    assert result.status=='unavailable' and result.reason=='mfa_dictionary_word_unavailable'
    assert result.words==[] and result.phones==[]
    # A second job must still go straight to align_one.
    assert engine.align(wav,'hello',0,tmp_path/'another',settings).reason=='mfa_dictionary_word_unavailable'
