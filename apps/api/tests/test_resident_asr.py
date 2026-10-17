"""Exercise real IPC/lifecycle without loading models or calling external services."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from app.services.acoustics import transcribe as asr
from app.services.acoustics.audio import AudioFailure


@pytest.fixture
def resident(monkeypatch):
    real_popen = subprocess.Popen
    children, verified = [], []
    script = '''
import json, sys, time
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    assert set(request) == {'audio'}
    audio = request['audio']
    if audio == 'hang': time.sleep(10)
    if audio == 'crash': sys.exit(1)
    if audio == 'invalid': print('not json', flush=True); continue
    if audio == 'bad-result': print('{}', flush=True); continue
    print(json.dumps({'text': audio, 'reliable': True}), flush=True)
'''
    def spawn(command, **kwargs):
        assert '--serve' in command and '--audio' not in command
        child = real_popen([sys.executable, '-u', '-c', script], **kwargs)
        children.append(child)
        return child
    monkeypatch.setattr(asr.subprocess, 'Popen', spawn)
    monkeypatch.setattr(asr, 'verify_model', lambda *args: verified.append(args))
    client = asr.ResidentASR()
    settings = SimpleNamespace(practice_asr_model_path='small.en', practice_asr_model_sha256='digest')
    yield client, settings, children
    client.close()
    assert all(child.poll() is not None for child in children)


def test_warmup_and_concurrent_takes_share_one_process(resident):
    client, settings, children = resident
    client.request(settings)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda i: client.request(settings, Path(str(i))), range(8)))
    assert [result['text'] for result in results] == [str(i) for i in range(8)]
    assert len(children) == 1


@pytest.mark.parametrize('audio,code', [('hang', 'asr_timeout'), ('crash', 'asr_failed'),
                                        ('invalid', 'asr_failed'), ('bad-result', 'asr_failed')])
def test_failure_reaps_child_and_next_take_restarts(resident, audio, code):
    client, settings, children = resident
    client.request(settings)
    client.timeout = .1
    with pytest.raises(AudioFailure) as error:
        client.request(settings, Path(audio))
    assert error.value.code == code
    assert children[0].poll() is not None
    client.timeout = 5
    assert client.request(settings, Path('next')) == {'text': 'next', 'reliable': True}
    assert len(children) == 2


def test_dead_idle_process_and_changed_identity_restart(resident):
    client, settings, children = resident
    client.request(settings)
    children[0].kill(); children[0].wait()
    client.request(settings, Path('next'))
    settings.practice_asr_model_sha256 = 'new-digest'
    client.request(settings, Path('next'))
    assert len(children) == 3 and children[1].poll() is not None


def test_failed_warmup_does_not_leave_a_process(resident, monkeypatch):
    client, settings, children = resident
    monkeypatch.setattr(client, '_read', lambda: {'ready': False})
    with pytest.raises(AudioFailure):
        client.request(settings)
    assert client.process is None and children[0].poll() is not None


@pytest.mark.parametrize('values,reliable', [
    ((-1.0, .59, 2.39), True), ((-1.01, .1, 1), False),
    ((-.5, .6, 1), False), ((-.5, .1, 2.4), False),
])
def test_recognition_parameters_and_reliability_are_unchanged(values, reliable):
    class Model:
        def transcribe(self, audio, **kwargs):
            assert audio == 'audio.wav'
            assert kwargs == dict(language='en', beam_size=5, temperature=0,
                                  condition_on_previous_text=False, initial_prompt=None, vad_filter=False, word_timestamps=True)
            return iter([SimpleNamespace(text=' words ', avg_logprob=values[0],
                no_speech_prob=values[1], compression_ratio=values[2])]), None
    assert asr.recognize(Model(), 'audio.wav') == {'text': 'words', 'words': [], 'reliable': reliable}
