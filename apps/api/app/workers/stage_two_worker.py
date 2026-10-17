"""One durable lane per process; prioritize Takes within each lane."""
from contextlib import nullcontext
import argparse
import logging
import signal
from threading import Event
from time import monotonic
from uuid import uuid4

import httpx
from app.config import get_settings
from app.integrations.practice_analysis_repository import get_practice_analysis_repository
from app.integrations.reference_repository import get_reference_repository
from app.services.acoustics import cpu_policy, mfa_runtime
from app.services.acoustics.transcribe import verify_model, warm_up, close_resident
from app.workers import acoustic_worker as reference, practice_analysis_worker as take

log = logging.getLogger(__name__)


def prepare(settings, lane):
    cpu_policy.configure(settings, lane)
    if lane == 'fast':
        if not settings.practice_asr_model_path or not settings.practice_asr_model_sha256:
            raise SystemExit('Provision the learner ASR model before starting the fast worker.')
        with cpu_policy.fast_activity():
            verify_model(settings.practice_asr_model_path, settings.practice_asr_model_sha256)
            warm_up(settings)
        log.info('Fast worker ready; resident ASR, no MFA startup or alignment.')
    else:
        mfa_runtime.check_startup(settings)
        log.info('Fine worker ready; MFA yields to local fast activity.')


def run_one(takes, references, settings, lane):
    token = str(uuid4())
    row = takes.claim(token, settings.acoustic_lease_seconds, lane)
    if row:
        with cpu_policy.fast_activity() if lane == 'fast' else nullcontext():
            take.process(takes, row, token, settings, lane=lane)
        return True
    row = references.claim(token, settings.acoustic_lease_seconds, lane)
    if row:
        with cpu_policy.fast_activity() if lane == 'fast' else nullcontext():
            reference.process(references, row, token, settings, lane=lane)
        return True
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--lane', choices=('fast', 'fine'), required=True)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    settings = get_settings()
    takes, references = get_practice_analysis_repository(), get_reference_repository()
    if not takes or not references:
        raise SystemExit('Configure Supabase before starting Stage 2 workers.')

    def stop(signum, frame):
        # Finally blocks stop heartbeats/model; the MFA supervisor reaps its group.
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, stop)
    next_cleanup = 0.0
    try:
        prepare(settings, args.lane)
        while True:
            worked = False
            try:
                if args.lane == 'fast':
                    worked = run_one(takes, references, settings, args.lane)
                else:
                    worked = run_one(takes, references, settings, args.lane)
                    if monotonic() >= next_cleanup:
                        take.reconcile(takes)
                        reference.reconcile(references)
                        next_cleanup = monotonic() + 60
            except httpx.HTTPError:
                log.warning('Stage 2 storage unavailable; retrying lane %s.', args.lane)
            if args.once:
                return
            if not worked:
                Event().wait(settings.acoustic_poll_seconds)
    finally:
        close_resident()


if __name__ == '__main__':
    main()
