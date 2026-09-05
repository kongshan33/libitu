from pathlib import Path
import shutil
import tarfile
import tempfile

import httpx

from app.integrations.local_punctuation import DEFAULT_MODEL_DIR, MODEL_NAME


MODEL_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/"
    f"{MODEL_NAME}.tar.bz2"
)
REQUIRED_FILES = ("model.int8.onnx", "bpe.vocab")


def main() -> None:
    DEFAULT_MODEL_DIR.mkdir(parents=True, exist_ok=True)
    if all((DEFAULT_MODEL_DIR / name).is_file() for name in REQUIRED_FILES):
        print(f"Punctuation model already exists at {DEFAULT_MODEL_DIR}")
        return

    with tempfile.TemporaryDirectory(prefix="libitu-punctuation-") as directory:
        archive_path = Path(directory) / f"{MODEL_NAME}.tar.bz2"
        with httpx.stream("GET", MODEL_URL, follow_redirects=True, timeout=120.0) as response:
            response.raise_for_status()
            with archive_path.open("wb") as archive_file:
                for chunk in response.iter_bytes():
                    archive_file.write(chunk)

        with tarfile.open(archive_path, "r:bz2") as archive:
            for filename in REQUIRED_FILES:
                member = next(
                    (
                        item
                        for item in archive.getmembers()
                        if item.isfile() and Path(item.name).name == filename
                    ),
                    None,
                )
                if member is None:
                    raise RuntimeError(f"Downloaded archive is missing {filename}.")
                source = archive.extractfile(member)
                if source is None:
                    raise RuntimeError(f"Could not read {filename} from the archive.")
                with source, (DEFAULT_MODEL_DIR / filename).open("wb") as destination:
                    shutil.copyfileobj(source, destination)

    print(f"Installed punctuation model at {DEFAULT_MODEL_DIR}")


if __name__ == "__main__":
    main()
