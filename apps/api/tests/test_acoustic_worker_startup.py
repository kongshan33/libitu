"""Only the fine lane verifies MFA; the fast lane preloads ASR before claims."""
from types import SimpleNamespace
import subprocess
import pytest
from app.config import Settings
from app.services.acoustics import mfa_runtime
from app.workers import stage_two_worker as worker


@pytest.mark.parametrize('failure', [None, 'mismatch', 'startup', 'timeout', 'missing'])
def test_fine_probe_once_before_claims(failure, tmp_path, monkeypatch):
    binary = tmp_path/'mfa'; binary.write_text('fixture')
    settings = Settings(_env_file=None, acoustic_mfa_binary=str(binary))
    calls=[]
    monkeypatch.setattr(worker.cpu_policy, 'configure', lambda *_: None)
    monkeypatch.setattr(worker, 'warm_up', lambda *_: pytest.fail('Fine startup must not load ASR'))
    def run(command, **kwargs):
        calls.append('version')
        assert command[1]=='version'
        if failure=='timeout': raise subprocess.TimeoutExpired(command,30)
        if failure=='missing': raise FileNotFoundError()
        return SimpleNamespace(returncode=1 if failure=='startup' else 0, stdout='4.0' if failure=='mismatch' else '3.3.9')
    monkeypatch.setattr(mfa_runtime.subprocess, 'run', run)
    if failure:
        with pytest.raises(SystemExit,match='MFA'): worker.prepare(settings,'fine')
    else:
        worker.prepare(settings,'fine')
        worker.prepare(settings,'fine')
    assert calls==['version']


def test_fast_never_checks_mfa(tmp_path, monkeypatch):
    settings=Settings(_env_file=None,practice_asr_model_path='model',practice_asr_model_sha256='a'*64)
    calls=[]
    monkeypatch.setenv(worker.cpu_policy.LOCK_ENV,str(tmp_path/'fast.lock'))
    monkeypatch.setattr(worker.cpu_policy,'configure',lambda *_:None)
    monkeypatch.setattr(worker.mfa_runtime,'check_startup',lambda *_:pytest.fail('No MFA on fast startup'))
    monkeypatch.setattr(worker,'verify_model',lambda *_:calls.append('verify'))
    monkeypatch.setattr(worker,'warm_up',lambda *_:calls.append('warm'))
    worker.prepare(settings,'fast')
    assert calls==['verify','warm']


def test_take_priority_and_no_idle_fast_lock(monkeypatch,tmp_path):
    monkeypatch.setenv(worker.cpu_policy.LOCK_ENV,str(tmp_path/'fast.lock'))
    calls=[]
    take=SimpleNamespace(claim=lambda token,seconds,lane: calls.append(('take',lane)) or {'id':'take'})
    ref=SimpleNamespace(claim=lambda *_:pytest.fail('Take has priority'))
    def process(*args,**kwargs):
        with open(tmp_path/'fast.lock','a') as lock: assert worker.cpu_policy.fast_busy(lock)
        calls.append('process')
    monkeypatch.setattr(worker.take,'process',process)
    assert worker.run_one(take,ref,SimpleNamespace(acoustic_lease_seconds=60),'fast')
    assert calls==[('take','fast'),'process']
    with open(tmp_path/'fast.lock','a') as lock: assert not worker.cpu_policy.fast_busy(lock)
