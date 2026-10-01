"""Explicit provisioning only. User requests never download or select models."""
import argparse
from hashlib import sha256
from pathlib import Path
import json

import httpx


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=Path('.models/acoustics'))
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=True)
    manifest=json.loads((Path(__file__).resolve().parents[1]/'deploy/acoustic-models.json').read_text())
    with httpx.Client(follow_redirects=True,timeout=60) as client:
        for model in manifest['models']:
            target=args.output/model['file']
            if target.is_file() and sha256(target.read_bytes()).hexdigest()==model['sha256']:
                print(f"Verified existing {target.name}");continue
            temporary=target.with_suffix(target.suffix+'.download')
            digest=sha256();size=0
            try:
                with client.stream('GET',model['url']) as response,temporary.open('wb') as output:
                    response.raise_for_status()
                    for chunk in response.iter_bytes():
                        size+=len(chunk)
                        if size>model['bytes']:raise ValueError('Model exceeds expected size')
                        digest.update(chunk);output.write(chunk)
                if size!=model['bytes'] or digest.hexdigest()!=model['sha256']:raise ValueError('Model integrity mismatch')
                temporary.replace(target)
                print(f"Verified {target.name}")
            finally:temporary.unlink(missing_ok=True)


if __name__=='__main__':main()
