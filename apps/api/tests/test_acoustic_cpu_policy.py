"""Real subprocess tests for MFA preemption, timeout and crash cleanup."""
import os
from pathlib import Path
import signal
import subprocess
import sys
from threading import Thread
import time
import pytest
from app.services.acoustics import cpu_policy as policy


def wait_for(predicate, seconds=5):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if predicate():return
        time.sleep(.02)
    pytest.fail('Subprocess did not reach expected state')


@pytest.fixture
def configured(tmp_path,monkeypatch):
    lock=tmp_path/'fast.lock'
    monkeypatch.setenv(policy.LOCK_ENV,str(lock))
    monkeypatch.setenv(policy.YIELD_ENV,'1')
    return lock


def test_pause_resume_and_active_timeout(configured,tmp_path):
    marker=tmp_path/'ticks'
    script="import time, pathlib\np=pathlib.Path(%r)\nfor i in range(40):\n p.write_text(str(i)); time.sleep(.02)" % str(marker)
    output=[]
    thread=Thread(target=lambda:output.append(policy.run([sys.executable,'-c',script],capture_output=True,timeout=1.5)))
    thread.start()
    try:
        wait_for(marker.exists)
        with policy.fast_activity(str(configured)):
            time.sleep(.15)
            first=marker.read_text()
            time.sleep(.8)  # wall time exceeds active timeout without consuming it
            assert marker.read_text()==first
        thread.join(5)
        assert not thread.is_alive() and output[0].returncode==0
        assert b'paused_sec=' in output[0].stderr
    finally:
        thread.join(5)


def test_active_timeout_kills_and_reaps(configured,tmp_path):
    pid_file=tmp_path/'pid'
    script=f'import os,time,pathlib; pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid())); time.sleep(10)'
    with pytest.raises(subprocess.TimeoutExpired):
        policy.run([sys.executable,'-c',script],capture_output=True,timeout=.3)
    pid=int(pid_file.read_text())
    with pytest.raises(ProcessLookupError):os.kill(pid,0)


def test_worker_crash_cleans_paused_mfa(configured,tmp_path):
    pid_file=tmp_path/'pid'
    child=f'import os,time,pathlib; pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid())); time.sleep(30)'
    parent=f'from app.services.acoustics.cpu_policy import run; import sys; run([sys.executable,"-c",{child!r}],capture_output=True,timeout=40)'
    proc=subprocess.Popen([sys.executable,'-c',parent],cwd=Path(__file__).resolve().parents[1])
    try:
        wait_for(pid_file.exists)
        pid=int(pid_file.read_text())
        with policy.fast_activity(str(configured)):
            time.sleep(.15)
            proc.kill();proc.wait()
            def gone():
                try:os.kill(pid,0);return False
                except ProcessLookupError:return True
            wait_for(gone)
    finally:
        if proc.poll() is None:proc.kill();proc.wait()


def test_fast_activity_lock_released_on_process_crash(configured,tmp_path):
    marker=tmp_path/'ready'
    script=f'from app.services.acoustics.cpu_policy import fast_activity; import pathlib,time\nwith fast_activity():\n pathlib.Path({str(marker)!r}).touch();time.sleep(30)'
    proc=subprocess.Popen([sys.executable,'-c',script],cwd=Path(__file__).resolve().parents[1])
    try:
        wait_for(marker.exists)
        with configured.open('a') as lock:
            assert policy.fast_busy(lock)
            proc.kill();proc.wait()
            assert not policy.fast_busy(lock)
    finally:
        if proc.poll() is None:proc.kill();proc.wait()


def test_cpu_overlap_rejected_without_changing_priority(tmp_path,monkeypatch):
    from app.config import Settings
    settings=Settings(_env_file=None,acoustic_scheduler_path=str(tmp_path),acoustic_fast_cpus='0,1',acoustic_fine_cpus='1,2')
    with pytest.raises(ValueError,match='disjoint'):policy.configure(settings,'fine')
