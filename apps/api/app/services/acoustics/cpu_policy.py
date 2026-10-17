"""Host-local fast activity and supervised, preemptible MFA subprocesses.

Only MFA's process group is paused. The worker retains its lease heartbeat.
The small supervisor survives worker death long enough to kill/reap MFA.
"""
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

LOCK_ENV = 'LIBITU_ACOUSTIC_FAST_LOCK'
YIELD_ENV = 'LIBITU_ACOUSTIC_YIELD'
THREAD_ENV = ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS',
              'VECLIB_MAXIMUM_THREADS', 'NUMEXPR_NUM_THREADS')


def cpu_set(value: str) -> set[int]:
    result = {int(item.strip()) for item in value.split(',') if item.strip()}
    if any(cpu < 0 for cpu in result):
        raise ValueError('CPU IDs must be nonnegative')
    return result


def configure(settings, lane: str):
    fast, fine = cpu_set(settings.acoustic_fast_cpus), cpu_set(settings.acoustic_fine_cpus)
    if bool(fast) != bool(fine) or fast & fine:
        raise ValueError('Configure both disjoint fast and fine CPU sets, or neither')
    if fast:
        if not hasattr(os, 'sched_setaffinity'):
            raise ValueError('CPU affinity is unavailable here; omit CPU sets for cooperative MFA yielding')
        selected = fast if lane == 'fast' else fine
        if not selected <= os.sched_getaffinity(0):
            raise ValueError('Configured CPUs are outside the allowed CPU set')
        os.sched_setaffinity(0, selected)
    root = Path(settings.acoustic_scheduler_path).resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.environ[LOCK_ENV] = str(root / 'fast.lock')
    os.environ[YIELD_ENV] = '1' if lane == 'fine' else '0'
    for key in THREAD_ENV:
        os.environ[key] = '1' if lane == 'fine' else '2'
    if lane == 'fine':
        current = os.getpriority(os.PRIO_PROCESS, 0)
        if settings.acoustic_fine_nice > current:
            os.nice(settings.acoustic_fine_nice - current)


@contextmanager
def fast_activity(path: str | None = None):
    """Shared locks permit multiple fast workers and vanish automatically on exit."""
    with open(path or os.environ[LOCK_ENV], 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_SH)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def fast_busy(lock) -> bool:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    fcntl.flock(lock, fcntl.LOCK_UN)
    return False


def run(command, **kwargs):
    """subprocess.run-compatible MFA call; offline/default callers stay unchanged."""
    if os.environ.get(YIELD_ENV) != '1':
        return subprocess.run(command, **kwargs)
    timeout = kwargs.pop('timeout')
    check = kwargs.pop('check', False)
    guarded = [sys.executable, str(Path(__file__).resolve()), os.environ[LOCK_ENV],
               str(timeout), str(os.getpid()), *map(str, command)]
    result = subprocess.run(guarded, **kwargs)
    if result.returncode == 124:
        raise subprocess.TimeoutExpired(command, timeout, output=result.stdout, stderr=result.stderr)
    result.args = command
    if check:
        result.check_returncode()
    return result


def supervise(lock_path: str, timeout: float, owner: int, command: list[str]) -> int:
    child = None
    paused = False
    active, waited = 0.0, 0.0
    started = previous = time.monotonic()

    def stop(signum, frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        with open(lock_path, 'a') as lock:
            while True:
                now = time.monotonic()
                elapsed, previous = now - previous, now
                if child is not None and not paused:
                    active += elapsed
                else:
                    waited += elapsed
                # Reparenting catches SIGKILL/crashes of the worker, too.
                if os.getppid() != owner:
                    return 125
                # Keep active-time budget meaningful while bounding starvation.
                if active >= timeout or now - started >= timeout + 900:
                    return 124
                busy = fast_busy(lock)
                if child is None:
                    if not busy:
                        child = subprocess.Popen(command, start_new_session=True)
                elif child.poll() is not None:
                    return child.returncode
                elif busy != paused:
                    try:
                        os.killpg(child.pid, signal.SIGSTOP if busy else signal.SIGCONT)
                        paused = busy
                    except ProcessLookupError:
                        return child.wait()
                time.sleep(0.05)
    finally:
        if child is not None:
            # Always kill the group, including grandchildren after leader exit.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        print(f'libitu_mfa_scheduler active_sec={active:.3f} paused_sec={waited:.3f}', file=sys.stderr)


if __name__ == '__main__':
    raise SystemExit(supervise(sys.argv[1], float(sys.argv[2]), int(sys.argv[3]), sys.argv[4:]))
