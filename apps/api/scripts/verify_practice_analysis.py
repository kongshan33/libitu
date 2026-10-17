"""Opt-in real storage + real ASR/MFA smoke using an explicitly supplied test WAV.

Use locally synthesized speech, not a learner's private recording. Authentication
and source registration are fixture boundaries; inference and Supabase IO are real.
"""
import argparse
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4
import subprocess
import time
import wave

from fastapi.testclient import TestClient
import httpx

from app.auth import AuthenticatedUser, require_user
from app.config import get_settings
from app.integrations.practice_analysis_repository import get_practice_analysis_repository
from app.integrations.reference_repository import get_reference_repository
from app.main import app
from app.schemas.blueprint import Blueprint, BlueprintSegment, TranscriptLine
from app.services.acoustics.sources import SourceGrant
from app.workers.practice_analysis_worker import process
from app.workers.acoustic_worker import process as process_reference


class RetryClient(TestClient):
    """Exercise the same immutable request again after a transient IO failure."""
    def request(self, *args, **kwargs):
        for attempt in range(4):
            response = super().request(*args, **kwargs)
            if response.status_code != 503:
                return response
            print('Transient storage failure; retrying the same fixture request.', flush=True)
            time.sleep(attempt + 1)
        return response


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-live', action='store_true', required=True)
    parser.add_argument('--audio', type=Path, required=True)
    parser.add_argument('--text', required=True)
    parser.add_argument('--browser-capture', action='store_true', help='Verify browser upload without a registered file grant')
    args = parser.parse_args()
    repo, references, settings = get_practice_analysis_repository(), get_reference_repository(), get_settings()
    if not repo or not references:
        raise SystemExit('Configure Supabase and acoustic models first.')
    from app.services.acoustics import mfa_runtime
    mfa_runtime.check_startup(settings)
    identifier = str(uuid4())
    owner, reference_id, analysis_ids = 'analysis-smoke-' + identifier, None, []
    with TemporaryDirectory(prefix='libitu-analysis-smoke-') as directory:
        wav, ogg = Path(directory) / 'reference.wav', Path(directory) / 'take.ogg'
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(args.audio.resolve()), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(wav)], check=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(wav), '-c:a', 'libopus', str(ogg)], check=True)
        reference_bytes, take_bytes = wav.read_bytes(), ogg.read_bytes()
        with wave.open(str(wav)) as audio:
            duration = int(audio.getnframes() * 1000 / audio.getframerate())
        origin = 120000
        sentence = TranscriptLine(id='sentence-v3-analysis-smoke', time='2:00', parts=[args.text],
            start_ms=origin, end_ms=origin+duration, segmentation_version='sentence-v3', source_token_start=0,
            source_token_end=len(args.text.split()))
        blueprint = Blueprint(id=str(uuid4()), content_id=identifier, title='Synthetic learner analysis verification',
            summary='', logic_flow=[], key_points=[], scenario_suggestions=[], transcript=[sentence],
            segments=[BlueprintSegment(id='segment', title='Test', summary='', start_ms=origin, end_ms=origin+duration,
                transcript_start_index=0, transcript_end_index=1)])
        grant = SourceGrant(id='synthetic-analysis-smoke', content_id=identifier, owners=[owner],
            rights_reference='Operator-supplied synthetic test speech; not learner data',
            expires_at=datetime.now(timezone.utc)+timedelta(hours=1), mode='upload', origin_ms=origin,
            end_ms=origin+duration, sha256=sha256(reference_bytes).hexdigest(), size=len(reference_bytes))
        try:
            repo.database._request('POST', '/contents', json={'id': identifier, 'kind': 'youtube', 'visibility': 'public',
                'normalized_key': 'analysis-smoke:'+identifier, 'title': blueprint.title, 'language': 'en'})
            app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id=owner)
            with patch('app.services.acoustics.sources.grants', return_value=[] if args.browser_capture else [grant]), \
                 patch('app.services.reference_service.get_blueprint', return_value=blueprint), \
                 patch('app.services.practice_service.get_blueprint', return_value=blueprint), \
                 patch('app.services.practice_service.find_blueprint_sentence', return_value=sentence), RetryClient(app) as client:
                reference = client.post('/api/references/captures' if args.browser_capture else '/api/references',
                    json={'content_id': identifier, 'segment_id': 'segment', **({'sentence_id':sentence.id,
                        'capture_id':identifier, 'start_ms':origin, 'end_ms':origin+duration,
                        'sha256':sha256(reference_bytes).hexdigest(),'size':len(reference_bytes),
                        'consent_version':'reference-analysis-v1'} if args.browser_capture else {})})
                assert reference.status_code == 202, reference.text
                reference_id = reference.json()['id']
                uploaded = client.put(f'/api/references/{reference_id}/audio', content=reference_bytes)
                assert uploaded.status_code == 200 and uploaded.json()['audio_ready'], uploaded.text
                token = str(uuid4())
                repo.database._request('PATCH','/acoustic_references', params={'id':'eq.'+reference_id,'user_id':'eq.'+owner},
                    json={'state':'processing','attempts':1,'lease_token':token,
                          'lease_until':(datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat()})
                process_reference(references,references.get(owner,reference_id),token,settings)
                prepared = client.get('/api/references/'+reference_id).json()
                assert prepared['state']=='completed', prepared
                assert prepared['results'][0]['prosody']['content']['status']=='source_transcript', prepared
                assert prepared['results'][0]['prosody']['words'], prepared
                if args.browser_capture:
                    recovered=client.get('/api/references/captures/latest',params={'content_id':identifier,'segment_id':'segment','sentence_id':sentence.id})
                    assert recovered.json()['id']==reference_id, recovered.text
                print('PASS: reference ASR/MFA/VAD/F0, verified cached word prosody and recovery.',flush=True)
                for mismatch in (False, True):
                    if mismatch:
                        sentence.parts = ['This recording contains a different set of words.']
                    attempt = client.post('/api/practice/attempts', json={'client_id': str(uuid4()), 'content_id': identifier,
                        'sentence_id': sentence.id, 'duration_ms': duration, 'playback_rate': 1, 'text_visible': True, 'recording': None})
                    assert attempt.status_code == 201, attempt.text
                    take = attempt.json()['id']
                    analysis_ids.append(take)
                    url = f'/api/practice/attempts/{take}/analysis'
                    payload = {'consent_version': 'practice-analysis-v1', 'size': len(take_bytes),
                        'sha256': sha256(take_bytes).hexdigest(), 'mime_type': 'audio/ogg',
                        'reference_id': None if mismatch else reference_id}
                    assert client.post(url, json=payload).status_code == 202
                    for _ in range(2):
                        response = client.put(url+'/audio', content=take_bytes, headers={'content-type': 'audio/ogg'})
                        assert response.status_code == 200 and response.json()['state'] in ('queued','processing','completed','needs_review'), response.text
                    # Lease only this fixture. Never claim another user's pending task.
                    # IO interruption/sleep can fence a running worker; simulate the
                    # next claim after its process returns, using a fresh token.
                    for run in range(3):
                        token = str(uuid4())
                        repo.database._request('PATCH', '/practice_analyses', params={'id': 'eq.'+take, 'user_id': 'eq.'+owner},
                            json={'state': 'processing', 'attempts': run+1, 'lease_token': token,
                                'lease_until': (datetime.now(timezone.utc)+timedelta(minutes=2)).isoformat()})
                        process(repo, repo.get(owner, take), token, settings)
                        result = client.get(url).json()
                        if result['state'] not in ('queued', 'processing'):
                            break
                        print('Recovering this fixture after interrupted worker IO/lease.', flush=True)
                    expected_state = 'needs_review' if mismatch else 'completed'
                    assert result['state'] == expected_state, result
                    if mismatch:
                        assert result['result']['learner']['content']['status'] == 'mismatch', result
                        assert result['result']['learner']['words'] == [], result
                        assert all(check['score']['value'] is None for check in result['result']['assessment']['sound'])
                    else:
                        assert result['result']['comparison'] == 'available', result
                        assert result['result']['learner']['words'], result
                        assert result['result']['reference']['words'], result
                        assessment = result['result']['assessment']
                        assert assessment['rhythm']['value'] is not None and assessment['melody']['value'] is not None, assessment
                        vowel = next(check for check in assessment['sound'] if check['kind']=='vowel_length')
                        assert vowel['score']['value'] is not None and vowel['pairs'], vowel
                        assert all(check['score']['value'] is None for check in assessment['sound'] if check['status']=='unsupported')
                        print('Saved experimental scores:', {k:assessment[k]['value'] for k in ('rhythm','melody')}, 'vowel timing:', vowel['score']['value'], flush=True)
                        with patch('app.services.practice_analysis_service.reference_for', return_value=None):
                            masked = client.get(url).json()['result']
                            assert masked['reference'] is None and masked['assessment'] is None and masked['comparison'] == 'unavailable'
                    # Exercise real cleanup candidate query, but touch only this fixture.
                    now = datetime.now(timezone.utc).isoformat()
                    assert repo.get(owner,take).get('input_cleaned_at') or any(row['id'] == take for row in repo.cleanup_candidates(now))
                    row = repo.get(owner, take)
                    repo.remove_audio(row)
                    repo.mark_clean(row, now)
                    try:
                        repo.read_audio(row)
                        raise AssertionError('Temporary input survived cleanup')
                    except httpx.HTTPStatusError as error:
                        assert error.response.status_code in (400, 404)
                    assert client.get(url).json()['result'] == result['result'], 'cleanup must retain derived result'
                    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id='other-'+owner)
                    assert client.get(url).status_code == 404 and client.delete(url).status_code == 404
                    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id=owner)
                    assert client.delete(url).status_code == 204
                    assert client.get(url).json()['result'] is None
                    print(f'PASS: real content {"mismatch" if mismatch else "match"}, alignment gate, storage, ownership, cleanup and deletion.', flush=True)
        finally:
            app.dependency_overrides.clear()
            for take in analysis_ids:
                row = repo.get(owner, take)
                if row:
                    repo.remove_audio(row)
                repo.database._request('DELETE', '/practice_analyses', params={'id': 'eq.'+take, 'user_id': 'eq.'+owner})
            repo.database._request('DELETE', '/shadow_attempts', params={'user_id': 'eq.'+owner})
            if reference_id:
                row = references.get(owner, reference_id)
                if row:
                    references.remove_audio(row)
                repo.database._request('DELETE', '/acoustic_references', params={'id': 'eq.'+reference_id, 'user_id': 'eq.'+owner})
            repo.database._request('DELETE', '/contents', params={'id': 'eq.'+identifier})
            repo.database._request('DELETE', '/profiles', params={'id': 'eq.'+owner})
            print('Synthetic fixture rows and objects removed.', flush=True)


if __name__ == '__main__':
    main()
