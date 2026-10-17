from array import array
from types import SimpleNamespace
import wave

import pytest

from app.schemas.reference import Alignment, Interval
from app.services.acoustics import practice_prosody as p
from app.services.acoustics.word_check import check_words


def test_word_check_uses_only_pcm_and_asr_before_gate(monkeypatch, tmp_path):
    wav = tmp_path / 'input.wav'
    with wave.open(str(wav), 'wb') as audio:
        audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        audio.writeframes(array('h', [1000, -1000] * 8000).tobytes())
    monkeypatch.setattr(p.engine, 'extract', lambda *a, **k: pytest.fail('Word check cannot run acoustic inference'))
    monkeypatch.setattr(p.engine, 'align', lambda *a, **k: pytest.fail('Word check cannot align'))
    calls = []
    monkeypatch.setattr(p, 'transcribe', lambda *a: calls.append('asr') or {'text': 'one two three', 'reliable': True})
    assert p.check_learner_words(wav, 'one two three four five', None).tier == 'partial_60_85'
    assert calls == ['asr']
    with wave.open(str(wav), 'wb') as audio:
        audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        audio.writeframes(array('h', [0]*16000).tobytes())
    check = p.check_learner_words(wav, 'one two three four five', None)
    assert check.tier is None and check.reason == 'insufficient_audio_quality'
    assert calls == ['asr']


@pytest.mark.parametrize('scope,include_pitch', [('sound_only', False), ('all_layers', True)])
def test_partial_alignment_uses_recognized_words_and_maps_exact_positions(monkeypatch, tmp_path, scope, include_pitch):
    check = check_words('one two three four five', {'text': 'one xx three four five', 'reliable': True})
    calls = []
    def extract(*args, **kwargs):
        calls.append(kwargs['include_pitch'])
        return [], [], [0]*16000
    monkeypatch.setattr(p.engine, 'extract', extract)
    measurements = SimpleNamespace(quality_issues=['insufficient_pitch'], frames=[], pauses=[], speech=[])
    monkeypatch.setattr(p.engine, 'sentence_measurements', lambda *args: measurements)
    def align(audio, text, *args):
        assert text == 'one xx three four five'
        return Alignment(status='aligned', words=[Interval(label=t, start_sec=i*.2, end_sec=(i+1)*.2)
                                                  for i, t in enumerate(text.split())])
    monkeypatch.setattr(p.engine, 'align', align)
    monkeypatch.setattr(p, 'transcribe', lambda *args: pytest.fail('Completed ASR must not repeat'))
    voice = p.analyze_checked_voice(tmp_path/'audio.wav', check, scope, tmp_path, None)
    assert calls == [include_pitch]
    assert [w.source_index for w in voice.words] == [0, None, 2, 3, 4]
    assert [w.recognized_index for w in voice.words] == list(range(5))
    assert voice.content.status == 'mismatch'
    if scope == 'sound_only':
        assert all(w.pitch_st is None and w.pitch_curve_st == [] for w in voice.words)
        assert 'insufficient_pitch' not in voice.quality_issues


def test_none_scope_never_loads_acoustic_models(monkeypatch, tmp_path):
    check = check_words('one two three four five', {'text': 'one two', 'reliable': True})
    monkeypatch.setattr(p.engine, 'extract', lambda *a, **k: pytest.fail('Below threshold'))
    monkeypatch.setattr(p.engine, 'align', lambda *a: pytest.fail('Below threshold'))
    voice = p.analyze_checked_voice(tmp_path/'audio.wav', check, 'none', tmp_path, None)
    assert voice.words == [] and voice.alignment_status == 'not_run'


def test_alignment_with_different_tokenization_withholds_mapping(monkeypatch, tmp_path):
    check = check_words('one two three four five', {'text': 'one two three four five', 'reliable': True})
    monkeypatch.setattr(p.engine, 'extract', lambda *a, **k: ([], [], [0]*16000))
    monkeypatch.setattr(p.engine, 'sentence_measurements', lambda *a: SimpleNamespace(quality_issues=[], frames=[], pauses=[], speech=[]))
    monkeypatch.setattr(p.engine, 'align', lambda *a: Alignment(status='aligned', words=[Interval(label='different', start_sec=0, end_sec=.5)]))
    voice = p.analyze_checked_voice(tmp_path/'audio.wav', check, 'all_layers', tmp_path, None)
    assert voice.words == [] and voice.alignment_status == 'unavailable'
    assert voice.quality_issues == ['alignment_token_mapping_unavailable']
