# Offline acoustic benchmark source register

Verified on 2026-09-13. The current seed contains **16 real human recordings from four speakers**, approximately 49.107 seconds / 1,572,142 audio bytes. All are assigned to `dev`; none constitute a held-out evaluation set. Audio bytes are unchanged, 16 kHz mono PCM16 WAV. No acoustic detector, human phenomenon annotation, or correctness score has been run or invented.

| Source | Selected recordings | License and evidence | Existing annotation boundary |
|---|---|---|---|
| CMU ARCTIC 0.95 | US English BDL `arctic_a0001`–`a0004`; SLT `arctic_a0005`–`a0008` | Custom CMU permissive license; original [BDL COPYING](http://festvox.org/cmu_arctic/cmu_arctic/cmu_us_bdl_arctic/COPYING), [SLT COPYING](http://festvox.org/cmu_arctic/cmu_arctic/cmu_us_slt_arctic/COPYING), with full copies retained in `public_seed/licenses/` | Official speaker pages describe automatic CMU Sphinx phone labels with no hand correction. These labels were not imported as human truth. Transcript comes from each speaker's `etc/txt.done.data`. |
| SpeechOcean762 | Adult Mandarin-L1 English speakers `0036` (21) and `1027` (37), four recordings each from the original training split | [OpenSLR 101](https://openslr.org/101/) identifies **CC BY 4.0**; the [author's repository](https://github.com/jimbozhang/speechocean762) also permits commercial and non-commercial download. Source commit pinned to `613968e3b0b789fc33936fb5eba1973176ba7d11`. | Corpus has five-expert pronunciation ratings at phone/word/sentence levels. They are neither timed connected-speech phenomenon labels nor gold pause/F0 boundaries. Scores were not imported. Original text, speaker mapping, age and gender metadata are retained as source metadata. |

The CMU license permits commercial use with its copyright, conditions, disclaimer and author names retained; modifications must be marked. SpeechOcean762 attribution, creator names, license link and requested citation are retained in [LICENSES.json](public_seed/LICENSES.json). CC BY 4.0 requires appropriate attribution, a license link and identification of changes; see the [license](https://creativecommons.org/licenses/by/4.0/) and [legal text](https://creativecommons.org/licenses/by/4.0/legalcode.en). This run is local benchmark development, implies no creator endorsement and does not train models. Preserve these notices and identify modifications when sharing derived artifacts.

The precise URLs, hashes, byte sizes, WAV format, original IDs, transcript text, source metadata hashes and acquisition timestamp are locked in [source_records.json](public_seed/source_records.json). CMU's official files were available through HTTP at acquisition; SHA-256 locks the retrieved bytes for reproducibility but is not independent proof of source authenticity. SpeechOcean files use HTTPS at the pinned author commit. Audio cache paths are relative to `.cache/acoustic-benchmark/public-seed/` and are not committed.

From the repository root:

```bash
apps/api/.venv/bin/python apps/api/scripts/download_acoustic_seed.py
apps/api/.venv/bin/python apps/api/scripts/download_acoustic_seed.py --verify-only
```

The downloader accepts exactly the 16 selected file URLs, caps each response at 2 MiB, rejects redirects and checksum/format mismatches, and never replaces mismatched existing files. It fetches missing WAV files individually, without downloading archives. `--verify-only` requires all files locally and makes no network request.

The selection is a small acquisition/annotation-workflow seed, not representative coverage or an accuracy claim. Recordings are unpaired across the two corpora; a CMU sentence cannot become the reference for a different SpeechOcean sentence. Keep each speaker/session and all later transformed descendants in one split. Source transcripts remain unverified against actual content. Pause and F0 targets require manual review, adjudication and a frozen held-out expansion before quality metrics are meaningful.

L2-ARCTIC was evaluated but not selected because its [official release](https://psi.engr.tamu.edu/l2-arctic-corpus/) is CC BY-NC 4.0. No L2-ARCTIC or Glossika audio was acquired. Glossika was not assessed as licensed for corpus ingestion in this run.
