"""Independent bounded CPU worker. PostgreSQL is the durable queue and status source."""
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Thread
import logging

import httpx

from app.config import Settings
from app.integrations.reference_repository import ReferenceRepository
from app.schemas.reference import Alignment, SentenceResult, Measurements
from app.services.acoustics.signal_prosody import analyze_signal, subtitle_boundaries
from app.services.acoustics import engine, sources, audio_cache
from app.services.acoustics.audio import AudioFailure, crop, file_hash, normalize
from app.services.acoustics.reference_prosody import align_reference, reference_identity, reference_version

log = logging.getLogger(__name__)


class LeaseLost(Exception):
    pass


def process(repo: ReferenceRepository, row: dict, token: str, settings: Settings, lane="combined") -> None:
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
        if row['analysis_version'] != reference_version(settings) or any(
                row['snapshot'].get(key) != value for key, value in reference_identity(settings).items()):
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
            # Persist all signal features before starting any sentence's MFA. Retry
            # reuses these frames, including energy, for the immutable input/engine.
            cached = {r['sentence_id']: r for r in row['results']}
            sentences = row['snapshot']['sentences']
            missing = any(not cached.get(s['id'], {}).get('measurements') for s in sentences)
            if missing and lane == 'fine':
                raise AudioFailure('fast_checkpoint_missing')
            if missing:
                frames, speech, samples = engine.extract(normalized, settings)
            results = []
            for sentence in sentences:
                prior = cached.get(sentence['id'])
                if prior and prior.get('measurements'):
                    results.append(prior)
                    continue
                start = (sentence['start_ms'] - row['start_ms']) / 1000
                end = (sentence['end_ms'] - row['start_ms']) / 1000
                measurements = engine.sentence_measurements(frames, speech, samples, start, end)
                coarse = analyze_signal(measurements, subtitle_boundaries(sentence), 'subtitle_word', origin=start)
                results.append(SentenceResult(sentence_id=sentence['id'], status='coarse_ready',
                    alignment=Alignment(status='unavailable', reason='alignment_pending'),
                    measurements=measurements, coarse=coarse).model_dump(mode='json'))
            if lane == 'fast':
                write('publish_handoff', {'results': results})
                return
            write('results', {'results': results})
            for index, sentence in enumerate(sentences):
                write('heartbeat', {'seconds': settings.acoustic_lease_seconds})
                if results[index]['status'] == 'completed':
                    continue
                start = (sentence['start_ms'] - row['start_ms']) / 1000
                end = (sentence['end_ms'] - row['start_ms']) / 1000
                measurements = Measurements.model_validate(results[index]['measurements'])
                coarse = results[index].get('coarse')
                try:
                    wav = work / f'sentence-{index}.wav'
                    origin = crop(normalized, wav, start, end)
                    alignment, prosody = align_reference(wav, sentence['text'], origin, measurements,
                        work / f'align-{index}', settings)
                    result = SentenceResult(sentence_id=sentence['id'], status='completed' if alignment.status == 'aligned' else 'partial',
                        alignment=alignment, measurements=measurements, prosody=prosody, coarse=coarse)
                except AudioFailure as error:
                    result = SentenceResult(sentence_id=sentence['id'], status='failed', measurements=measurements, coarse=coarse,
                        alignment=Alignment(status='failed', reason=error.code), error_code=error.code)
                results[index] = result.model_dump(mode='json')
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
    audio_cache.prune()
    now = datetime.now(timezone.utc)
    for row in repo.cleanup_candidates(now.isoformat(), (now - timedelta(days=1)).isoformat()):
        repo.control(row['user_id'], row['id'], 'delete')
        repo.remove_audio(row)
        repo.mark_clean(row, now.isoformat())


def main():
    raise SystemExit("Use app.workers.stage_two_worker --lane fast and --lane fine in separate processes.")


if __name__ == '__main__':
    main()
