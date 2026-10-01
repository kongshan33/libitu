"""Offline reference validation using the same production measurements/alignment adapters."""
import argparse
from pathlib import Path
from tempfile import TemporaryDirectory
import json

from app.config import get_settings
from app.schemas.reference import SentenceSnapshot, SentenceResult
from app.services.acoustics import engine
from app.services.acoustics.audio import crop, file_hash, normalize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audio', type=Path, required=True)
    parser.add_argument('--sentences', type=Path, required=True, help='JSON array of existing id/text/start_ms/end_ms')
    parser.add_argument('--origin-ms', type=int, required=True, help='Video timestamp of the first input audio sample')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    sentences = [SentenceSnapshot.model_validate(s) for s in json.loads(args.sentences.read_text())]
    if not sentences or len({s.id for s in sentences}) != len(sentences):
        raise SystemExit('Expected nonempty unique sentence identities')
    start, end = min(s.start_ms for s in sentences), max(s.end_ms for s in sentences)
    settings = get_settings()
    results = []
    with TemporaryDirectory(prefix='libitu-offline-acoustic-') as directory:
        work = Path(directory); wav = work / 'reference.wav'
        normalize(args.audio.resolve(), wav, start - args.origin_ms, end - start)
        frames, speech, samples = engine.extract(wav, settings)
        for index, sentence in enumerate(sentences):
            first, last = (sentence.start_ms-start)/1000, (sentence.end_ms-start)/1000
            clip = work / f'{index}.wav'
            origin = crop(wav, clip, first, last)
            alignment = engine.align(clip, sentence.text, origin, work / f'align-{index}', settings)
            measured = engine.sentence_measurements(frames, speech, samples, first, last)
            results.append(SentenceResult(sentence_id=sentence.id, status='completed' if alignment.status=='aligned' else 'partial',
                                          alignment=alignment, measurements=measured).model_dump(mode='json'))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'engine': engine.engine_identity(settings), 'audio_sha256': file_hash(args.audio),
        'segment_start_ms': start, 'segment_end_ms': end, 'results': results}, indent=2))
    print(json.dumps({'sentences': len(results), 'aligned': sum(r['alignment']['status']=='aligned' for r in results), 'output': str(args.output)}))


if __name__ == '__main__':
    main()
