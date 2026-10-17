from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace

from app.config import Settings
from app.services.acoustics import mfa_runtime


def test_integrity_is_reused_but_changed_files_are_rechecked(tmp_path, monkeypatch):
    model = tmp_path/'model'; model.write_bytes(b'valid')
    original = mfa_runtime.file_hash; calls = []
    monkeypatch.setattr(mfa_runtime, 'file_hash', lambda path: (calls.append(path), original(path))[1])
    digest = sha256(b'valid').hexdigest()
    assert mfa_runtime.verified(model, digest)
    assert mfa_runtime.verified(model, digest)
    assert len(calls) == 1
    model.write_bytes(b'changed')
    assert not mfa_runtime.verified(model, digest)
    assert len(calls) == 2


def test_binary_version_is_checked_once_per_binary_identity(tmp_path, monkeypatch):
    binary = tmp_path/'mfa'; binary.write_text('one'); calls = []
    monkeypatch.setattr(mfa_runtime.subprocess, 'run', lambda *a, **kw: (calls.append(a), SimpleNamespace(returncode=0, stdout='3.3.9'))[1])
    assert mfa_runtime.version_ok(binary, '')
    assert mfa_runtime.version_ok(binary, '')
    assert len(calls) == 1
    binary.write_text('replacement')
    assert mfa_runtime.version_ok(binary, '')
    assert len(calls) == 2


def test_jobs_share_only_complete_versioned_lexicons(tmp_path):
    settings = Settings(_env_file=None, acoustic_mfa_cache_path=str(tmp_path/'cache'), acoustic_mfa_dictionary='english.dict')
    def target(job): return job/'work/extracted_models/dictionary/english'
    job = tmp_path/'first'
    with mfa_runtime.lexicon_cache(settings, {'model':'one'}, job):
        target(job).mkdir()
        for name in ('L.fst', 'L_align.fst', 'words.txt', 'phones.txt'):
            (target(job)/name).write_text('compiled')
    with mfa_runtime.lexicon_cache(settings, {'model':'one'}, tmp_path/'second'):
        assert (target(tmp_path/'second')/'L.fst').read_text() == 'compiled'
        assert not (tmp_path/'second'/'alignment.json').exists()
    with mfa_runtime.lexicon_cache(settings, {'model':'two'}, tmp_path/'third'):
        assert not target(tmp_path/'third').exists()


def test_interrupted_lexicon_build_is_repaired(tmp_path):
    settings = Settings(_env_file=None, acoustic_mfa_cache_path=str(tmp_path/'cache'), acoustic_mfa_dictionary='english.dict')
    with mfa_runtime.lexicon_cache(settings, {}, tmp_path/'first'):
        path=tmp_path/'first/work/extracted_models/dictionary/english'
        path.mkdir(); (path/'L.fst').write_text('incomplete')
    with mfa_runtime.lexicon_cache(settings, {}, tmp_path/'second'):
        assert not (tmp_path/'second/work/extracted_models/dictionary/english/L.fst').exists()


def test_concurrent_cold_jobs_wait_for_complete_dictionary(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    settings = Settings(_env_file=None, acoustic_mfa_cache_path=str(tmp_path/'cache'), acoustic_mfa_dictionary='english.dict')
    building, release, second_started = Event(), Event(), Event()
    def first():
        with mfa_runtime.lexicon_cache(settings, {}, tmp_path/'first'):
            path = tmp_path/'first/work/extracted_models/dictionary/english'
            path.mkdir(); building.set()
            assert release.wait(5)
            for name in ('L.fst', 'L_align.fst', 'words.txt', 'phones.txt'):
                (path/name).write_text('complete')
    def second():
        second_started.set()
        with mfa_runtime.lexicon_cache(settings, {}, tmp_path/'second'):
            assert (tmp_path/'second/work/extracted_models/dictionary/english/L.fst').read_text() == 'complete'
    with ThreadPoolExecutor(max_workers=2) as pool:
        one = pool.submit(first); assert building.wait(5)
        two = pool.submit(second); assert second_started.wait(5)
        release.set(); one.result(timeout=5); two.result(timeout=5)


def test_failed_version_probe_is_not_cached_and_has_private_runtime(tmp_path, monkeypatch):
    import pytest
    binary = tmp_path/'mfa'; binary.write_text('one'); roots = []
    def run(*args, **kwargs):
        roots.append(Path(kwargs['env']['MFA_ROOT_DIR']))
        assert roots[-1].is_dir()
        return SimpleNamespace(returncode=1 if len(roots) == 1 else 0, stdout='3.3.9')
    monkeypatch.setattr(mfa_runtime.subprocess, 'run', run)
    with pytest.raises(mfa_runtime.StartupFailure):
        mfa_runtime.version_ok(binary, '')
    assert mfa_runtime.version_ok(binary, '')
    assert mfa_runtime.version_ok(binary, '')
    assert len(roots) == 2 and roots[0] != roots[1]
    assert all(not root.exists() for root in roots)


def test_version_requires_exact_match_and_rechecks_repaired_runtime(tmp_path, monkeypatch):
    binary = tmp_path/'mfa'; binary.write_text('one'); versions = iter(['13.3.90', '3.3.9'])
    monkeypatch.setattr(mfa_runtime.subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=0, stdout=next(versions)))
    assert not mfa_runtime.version_ok(binary, '')
    assert mfa_runtime.version_ok(binary, '')
