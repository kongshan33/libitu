"""Best-effort, bounded local handoff. Durable storage remains authoritative."""
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import logging
import os
import tempfile
import time

from app.config import get_settings

log = logging.getLogger(__name__)
TTL = 1800
MAX_BYTES = 256 * 1024 * 1024


def location(namespace: str, row: dict, digest: str) -> Path:
    key = sha256(f"{namespace}:{row['user_id']}:{row['id']}".encode()).hexdigest()
    suffix = sha256(digest.encode()).hexdigest()
    return Path(get_settings().acoustic_audio_cache_path).resolve() / f"{key}-{suffix}.audio"


def valid(row: dict) -> bool:
    expires = row.get('input_expires_at') or row.get('expires_at')
    return row.get('state') != 'deleted' and not row.get('input_cleaned_at') and (
        not expires or datetime.fromisoformat(expires) > datetime.now(timezone.utc))


def prune() -> None:
    try:
        root = Path(get_settings().acoustic_audio_cache_path).resolve()
        for unfinished in root.glob('.upload-*'):
            if unfinished.stat().st_mtime < time.time() - TTL:
                unfinished.unlink(missing_ok=True)
        files = sorted(((p.stat().st_mtime, p.stat().st_size, p) for p in root.glob('*.audio')), reverse=True)
        total = 0
        for modified, size, path in files:
            total += size
            if modified < time.time() - TTL or total > MAX_BYTES:
                path.unlink(missing_ok=True)
    except OSError:
        pass  # Cache availability never determines whether a job can run.


def put(namespace: str, row: dict, data: bytes) -> None:
    temporary = None
    try:
        if not valid(row) or len(data) > MAX_BYTES:
            return
        path = location(namespace, row, sha256(data).hexdigest())
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.upload-', delete=False) as output:
            temporary = Path(output.name)
            output.write(data)
        os.replace(temporary, path)
        prune()
    except OSError:
        log.info('Local audio handoff unavailable; durable input will be used.')
    finally:
        if temporary:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def get(namespace: str, row: dict, digest: str) -> bytes | None:
    try:
        path = location(namespace, row, digest)
        if not valid(row) or path.stat().st_mtime < time.time() - TTL:
            path.unlink(missing_ok=True)
            return None
        data = path.read_bytes()
        if sha256(data).hexdigest() != digest:
            path.unlink(missing_ok=True)
            return None
        log.info('Audio input source=local purpose=%s', namespace)
        return data
    except OSError:
        return None


def remove(namespace: str, row: dict, digest: str) -> None:
    try:
        path = location(namespace, row, digest)
        for candidate in path.parent.glob(path.name.split('-')[0] + '-*.audio'):
            candidate.unlink(missing_ok=True)
    except OSError:
        pass
