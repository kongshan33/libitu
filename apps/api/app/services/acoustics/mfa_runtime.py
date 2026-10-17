"""Reuse verified model assets and compiled lexicons, never sentence audio/results."""
from app.services.acoustics import cpu_policy
from contextlib import contextmanager
from functools import lru_cache
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import fcntl
import json
import logging
import os
import shutil
import subprocess
import re

from app.services.acoustics.audio import file_hash
from app.config import Settings


def fingerprint(path: Path) -> tuple:
    stat = path.stat()
    return str(path.resolve()), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


@lru_cache(maxsize=16)
def _verified(identity: tuple, digest: str) -> bool:
    return file_hash(Path(identity[0])) == digest


def verified(path: Path, digest: str | None) -> bool:
    return bool(digest and path.is_file() and _verified(fingerprint(path), digest))


class VersionMismatch(ValueError):
    pass


class StartupFailure(RuntimeError):
    pass


@lru_cache(maxsize=8)
def _version(identity: tuple, search_path: str) -> bool:
    import os
    # The CLI imports its runtime even for `version`. Isolate that initialization
    # and never cache a failed process as a permanent version mismatch.
    with TemporaryDirectory(prefix='libitu-mfa-version-') as root:
        result = cpu_policy.run([identity[0], 'version'], capture_output=True, text=True, timeout=30,
                                env={**os.environ, 'PATH': search_path, 'MFA_ROOT_DIR': root})
    if result.returncode != 0:
        raise StartupFailure('MFA version probe could not start')
    output = re.sub(r'\x1b\[[0-9;]*m', '', result.stdout).strip()
    if output != '3.3.9':
        raise VersionMismatch('Unexpected MFA version')
    return True


def version_ok(binary: Path, search_path: str) -> bool:
    executable = shutil.which(str(binary)) or str(binary)
    try:
        return _version(fingerprint(Path(executable)), search_path)
    except VersionMismatch:
        return False


def search_path(binary: Path) -> str:
    # Use the same decoder/runtime path for startup and actual alignment.
    decoder = shutil.which('ffmpeg')
    decoder_bin = str(Path(decoder).resolve().parent) + os.pathsep if decoder else ''
    return decoder_bin + str(binary.resolve().parent) + os.pathsep + os.environ.get('PATH', '')


def check_startup(settings: Settings) -> None:
    """Run before claiming jobs; configuration failures must not consume takes."""
    binary = Path(settings.acoustic_mfa_binary).expanduser()
    try:
        if not version_ok(binary, search_path(binary)):
            raise SystemExit('MFA startup failed: expected version 3.3.9. Fix the runtime and restart the worker.')
    except subprocess.TimeoutExpired:
        raise SystemExit('MFA startup check timed out. Check the runtime and restart the worker.') from None
    except (StartupFailure, OSError):
        raise SystemExit('MFA could not start. Check the configured executable and restart the worker.') from None
    logging.getLogger(__name__).info('MFA 3.3.9 startup check passed.')


@contextmanager
def lexicon_cache(settings, identity: dict, directory: Path):
    key = sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    root = Path(settings.acoustic_mfa_cache_path).resolve() / key
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    marker = root / 'ready'
    dictionary = root / 'dictionary'
    name = Path(settings.acoustic_mfa_dictionary).stem
    expected = [dictionary / name / p for p in ('L.fst', 'L_align.fst', 'words.txt', 'phones.txt')]

    def ready():
        return marker.is_file() and all(p.is_file() and p.stat().st_size for p in expected)

    # Warm jobs may read together; only one process may build/repair the lexicon.
    with (root / 'build.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_SH)
        building = not ready()
        if building:
            fcntl.flock(lock, fcntl.LOCK_UN)
            fcntl.flock(lock, fcntl.LOCK_EX)
            building = not ready()
            if building:
                marker.unlink(missing_ok=True)
                shutil.rmtree(dictionary, ignore_errors=True)
        dictionary.mkdir(exist_ok=True)
        target = directory / 'work' / 'extracted_models' / 'dictionary'
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.is_symlink():
            target.symlink_to(dictionary, target_is_directory=True)
        try:
            yield
            if building and all(p.is_file() and p.stat().st_size for p in expected):
                marker.write_text('mfa-3.3.9', encoding='utf-8')
        except BaseException:
            marker.unlink(missing_ok=True)
            raise
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
