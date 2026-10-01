"""Independent bounded CPU worker. PostgreSQL is the durable queue and status source."""
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Thread
from uuid import uuid4
import argparse
import logging

import httpx

from app.config import Settings, get_settings
from app.integrations.reference_repository import ReferenceRepository, get_reference_repository
from app.schemas.reference import Alignment, SentenceResult
from app.services.acoustics import engine, sources
from app.services.acoustics.audio import AudioFailure, crop, file_hash, normalize
from app.services.acoustics.practice_prosody import check_content, word_measurements
from app.services.acoustics.transcribe import transcribe
from app.schemas.practice_analysis import VoiceProsody

log = logging.getLogger(__name__)


class LeaseLost(Exception):
    pass


def process(repo: ReferenceRepository, row: dict, token: str, settings: Settings) -> None:
    stopped, lost = Event(), Event()

    def write(action: str, data: dict | None = None):
        if not sources.row_available(row):
            raise AudioFailure('source_unavailable')
        if lost.is_set() or not repo.fenced(row['id'], token, action, data):
            raise LeaseLost()

    def heartbeat():
        while not stopped.wait(settings.acoustic_lease_seconds / 3):
            try:
                if not repo.fenced(row['id'], token, 'heartbeat', {'seconds': settings.acoustic_lease_seconds}):
                    lost.set()
                    return
            except httpx.HTTPError:
                lost.set()
                return

    thread = Thread(target=heartbeat, daemon=True)
    thread.start()
    try:
        grant = sources.resolve_row(row)
        browser = sources.is_browser_capture(row)
        if (grant is None and not browser) or not repo.source_available(row['user_id'], row['content_id']):
            raise AudioFailure('source_unavailable')
        if row['snapshot']['engine'] != engine.engine_identity(settings):
            raise AudioFailure('worker_version_mismatch')
        if browser and row['snapshot'].get('asr_sha256') != settings.practice_asr_model_sha256:
            raise AudioFailure('worker_version_mismatch')
        with TemporaryDirectory(prefix='libitu-acoustic-') as temporary:
            work = Path(temporary)
            normalized = work / 'reference.wav'
            if row['audio_ready']:
                data = repo.read_audio(row)
                if sha256(data).hexdigest() != row['audio_sha256']:
                    raise AudioFailure('reference_integrity_failed')
                normalized.write_bytes(data)
            else:
                if grant is None or grant.mode != 'file':
                    raise AudioFailure('upload_not_ready')
                source = Path(grant.path)
                if not source.is_file() or source.stat().st_size != grant.size or file_hash(source) != grant.sha256:
                    raise AudioFailure('source_integrity_failed')
                normalize(source, normalized, row['start_ms'] - grant.origin_ms, row['end_ms'] - row['start_ms'])
                write('heartbeat', {'seconds': settings.acoustic_lease_seconds})
                data = normalized.read_bytes()
                repo.upload(row, data)
                write('audio', {'sha256': sha256(data).hexdigest()})
            frames, speech, samples = engine.extract(normalized, settings)
            # Retry reuses completed sentence results for this immutable engine/input identity.
            completed = {r['sentence_id']: r for r in row['results'] if r['status'] == 'completed'}
            results = []
            for index, sentence in enumerate(row['snapshot']['sentences']):
                write('heartbeat', {'seconds': settings.acoustic_lease_seconds})
                if not sources.row_available(row):
                    raise AudioFailure('source_unavailable')
                if sentence['id'] in completed:
                    results.append(completed[sentence['id']])
                    write('results', {'results': results})
                    continue
                start = (sentence['start_ms'] - row['start_ms']) / 1000
                end = (sentence['end_ms'] - row['start_ms']) / 1000
                try:
                    prosody = None
                    measurements = engine.sentence_measurements(frames, speech, samples, start, end)
                    if any(issue in measurements.quality_issues for issue in ('insufficient_speech', 'low_energy', 'clipping')):
                        alignment = Alignment(status='unavailable', reason='insufficient_audio_quality')
                    else:
                        wav = work / f'sentence-{index}.wav'
                        origin = crop(normalized, wav, start, end)
                        content = check_content(sentence['text'], transcribe(wav, settings)) if settings.practice_asr_model_path else None
                        alignment = engine.align(wav, sentence['text'], origin, work / f'align-{index}', settings) if content is None or content.status == 'matched' \
                            else Alignment(status='unavailable', reason='reference_content_unverified')
                        if content:
                            words = word_measurements(alignment, measurements) if alignment.status == 'aligned' else []
                            for word in words:
                                word.start_sec = max(0, word.start_sec - origin)
                                word.end_sec = max(0, word.end_sec - origin)
                            prosody = VoiceProsody(content=content, alignment_status=alignment.status,
                                quality_issues=measurements.quality_issues, words=words)
                    result = SentenceResult(sentence_id=sentence['id'], status='completed' if alignment.status == 'aligned' else 'partial',
                                            alignment=alignment, measurements=measurements, prosody=prosody)
                except AudioFailure as error:
                    result = SentenceResult(sentence_id=sentence['id'], status='failed',
                                            alignment=Alignment(status='failed', reason=error.code), error_code=error.code)
                results.append(result.model_dump(mode='json'))
                write('results', {'results': results})
            state = 'completed' if all(r['status'] == 'completed' for r in results) else 'partially_completed'
            write('finish', {'state': state})
    except LeaseLost:
        log.info('Reference lease ended: %s', row['id'])
    except AudioFailure as error:
        repo.fenced(row['id'], token, 'finish', {'state': 'failed', 'error_code': error.code})
    except ImportError:
        repo.fenced(row['id'], token, 'finish', {'state': 'failed', 'error_code': 'acoustic_dependencies_unavailable'})
    except httpx.HTTPError:
        # If even this write fails, lease expiry recovers it; attempts remain bounded.
        try:
            repo.fenced(row['id'], token, 'retry', {'error_code': 'storage_unavailable'})
        except httpx.HTTPError:
            pass
    except Exception:
        # Never persist raw exception/provider output, paths, credentials or source transcript.
        log.error('Reference processing failed: %s', row['id'])
        repo.fenced(row['id'], token, 'finish', {'state': 'failed', 'error_code': 'analysis_failed'})
    finally:
        stopped.set()
        thread.join(timeout=1)
        # A delete during object upload must not leave a resurrected object.
        current = repo.get(row['user_id'], row['id'])
        if current and current['state'] == 'deleted':
            repo.remove_audio(row)


def reconcile(repo: ReferenceRepository) -> None:
    now = datetime.now(timezone.utc)
    for row in repo.cleanup_candidates(now.isoformat(), (now - timedelta(days=1)).isoformat()):
        repo.control(row['user_id'], row['id'], 'delete')
        repo.remove_audio(row)
        repo.mark_clean(row, now.isoformat())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    settings = get_settings()
    repo = get_reference_repository()
    if repo is None:
        raise SystemExit('Configure server Supabase storage before starting the acoustic worker.')
    stop = Event()
    while True:
        try:
            reconcile(repo)
            token = str(uuid4())
            row = repo.claim(token, settings.acoustic_lease_seconds)
            if row:
                process(repo, row, token, settings)
        except httpx.HTTPError:
            log.warning('Reference storage unavailable; retrying after the polling interval.')
        if args.once:
            return
        stop.wait(settings.acoustic_poll_seconds)


if __name__ == '__main__':
    main()
