"""Operator-only source registration: emits a grant, never downloads third-party media."""
import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import wave

from app.services.acoustics.audio import file_hash
from app.services.acoustics.sources import SourceGrant


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path)
    parser.add_argument('--id', required=True)
    parser.add_argument('--content-id', required=True)
    parser.add_argument('--owner', action='append', required=True)
    parser.add_argument('--rights-reference', required=True)
    parser.add_argument('--origin-ms', type=int, default=0)
    parser.add_argument('--duration-ms', type=int, help='Required for containers other than WAV')
    parser.add_argument('--upload', action='store_true', help='Allow only these exact bytes through the authenticated upload API')
    parser.add_argument('--days', type=int, default=30, choices=range(1, 366))
    args = parser.parse_args()
    path = args.file.resolve(strict=True)
    duration = args.duration_ms
    if duration is None:
        with wave.open(str(path)) as audio:
            duration = round(audio.getnframes() * 1000 / audio.getframerate())
    grant = SourceGrant(id=args.id, content_id=args.content_id, owners=args.owner,
                        rights_reference=args.rights_reference, expires_at=datetime.now(timezone.utc) + timedelta(days=args.days),
                        mode='upload' if args.upload else 'file', origin_ms=args.origin_ms, end_ms=args.origin_ms + duration,
                        sha256=file_hash(path), size=path.stat().st_size, path=None if args.upload else str(path))
    print(json.dumps([grant.model_dump(mode='json')], indent=2))


if __name__ == '__main__':
    main()
