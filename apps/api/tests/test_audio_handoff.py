from datetime import datetime, timedelta, timezone
from hashlib import sha256
import os
import time

import httpx
import pytest

from app.integrations.practice_analysis_repository import PracticeAnalysisRepository
from app.integrations.reference_repository import ReferenceRepository
from app.services.acoustics import audio_cache


@pytest.mark.parametrize('kind,namespace,hash_field', [
    (PracticeAnalysisRepository, 'practice-analysis-inputs', 'input_sha256'),
    (ReferenceRepository, 'reference-audio', 'audio_sha256')])
def test_uploaded_bytes_are_local_with_durable_fallback_and_delete(kind, namespace, hash_field):
    data = b'audio'; requests = []
    row = dict(id='id', user_id='owner', input_mime='audio/ogg', state='queued',
               input_sha256=sha256(data).hexdigest(), audio_sha256=sha256(data).hexdigest())
    def transport(request):
        requests.append(request.method)
        return httpx.Response(200, content=data)
    repo = kind.__new__(kind)
    repo.storage = httpx.Client(transport=httpx.MockTransport(transport), base_url='https://storage.test/')
    try:
        repo.upload(row, data)
        assert repo.read_audio(row) == data
        assert requests == ['POST'], 'worker should not download the uploaded bytes again'
        path = audio_cache.location(namespace, row, row[hash_field])
        assert path.stat().st_mode & 0o777 == 0o600
        path.write_bytes(b'corrupt')
        assert repo.read_audio(row) == data
        assert requests == ['POST', 'GET'], 'corrupt cache falls back to durable input'
        audio_cache.put(namespace, row, data)
        repo.remove_audio(row)
        assert not path.exists()
        assert requests[-1] == 'DELETE'
    finally:
        repo.storage.close()


def test_cache_is_scoped_expiring_and_bounded(monkeypatch):
    row = dict(id='id', user_id='owner', state='queued')
    digest = sha256(b'audio').hexdigest()
    audio_cache.put('analysis', row, b'audio')
    assert audio_cache.get('analysis', {**row, 'user_id': 'other'}, digest) is None
    assert audio_cache.get('reference', row, digest) is None
    path = audio_cache.location('analysis', row, digest)
    os.utime(path, (time.time()-audio_cache.TTL-1,)*2)
    assert audio_cache.get('analysis', row, digest) is None
    audio_cache.put('analysis', row, b'audio')
    expired = (datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat()
    assert audio_cache.get('analysis', {**row, 'input_expires_at': expired}, digest) is None
    audio_cache.put('analysis', row, b'audio')
    monkeypatch.setattr(audio_cache, 'MAX_BYTES', 1)
    audio_cache.prune()
    assert not path.exists()


def test_delete_clears_late_reference_cache_before_audio_hash_is_acknowledged():
    row = dict(id='id', user_id='owner', state='awaiting_upload')
    audio_cache.put('reference', row, b'normalized')
    audio_cache.remove('reference', row, '')
    assert audio_cache.get('reference', row, sha256(b'normalized').hexdigest()) is None
