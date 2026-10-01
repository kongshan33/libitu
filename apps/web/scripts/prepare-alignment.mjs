import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const filename = "charsiu-en-fc-10ms-int8.onnx";
const sha256 = "53f5b163ea1f9f995ecf38bfc91994411505d8a970b912cf6b5544c8f28e916d";
const bytes = 123010803;
const revision = "d22b7e9b99d5fb2bed3e10fa8014917c2a4403dd";
const url = `https://huggingface.co/mnaoizyyy/charsiu-js-models/resolve/${revision}/en_w2v2_fc_10ms/model_quantized.onnx`;
const target = join(root, "public/acoustic-assets/local-alignment-v1");
const cache = join(root, ".models/local-alignment-v1");
const source = process.env.LIBITU_ALIGNMENT_MODEL ? resolve(process.env.LIBITU_ALIGNMENT_MODEL) : join(cache, filename);
// Check before the cached-target fast path too, so stale runtime pins cannot pass.
const assets = await readFile(join(root, "features/stage-two/alignment/assets.ts"), "utf8");
if (!assets.includes(sha256) || !assets.includes(String(bytes)) || !assets.includes(filename)) throw new Error("The alignment worker and preparation asset pins disagree.");

async function valid(path) {
  try {
    if ((await stat(path)).size !== bytes) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex") === sha256;
  } catch { return false; }
}

await mkdir(target, { recursive: true });
await copyFile(join(root, "features/stage-two/alignment/THIRD_PARTY_LICENSES.txt"), join(target, "LICENSES.txt"));
await writeFile(join(target, "manifest.json"), `${JSON.stringify({ version: "charsiu-en-fc-10ms-v1", filename, bytes, sha256, url, revision, sampleRate: 16000, frameMs: 10, classes: 42, license: "MIT" }, null, 2)}\n`);

if (await valid(join(target, filename))) {
  console.log("Prepared verified local word alignment model (no network requests).");
  process.exit(0);
}

if (!await valid(source) && process.argv.includes("--download")) {
  await mkdir(dirname(source), { recursive: true });
  const temporary = `${source}.download-${process.pid}`;
  try {
    console.log(`Downloading the pinned local word alignment model (${(bytes / 1024 / 1024).toFixed(1)} MiB).`);
    const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`Alignment model download failed (${response.status}).`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    if (!await valid(temporary)) throw new Error("Downloaded alignment model failed its size/hash check.");
    await rename(temporary, source);
  } finally { await rm(temporary, { force: true }); }
}

if (!await valid(source)) {
  // The existing local VAD/pitch and ordinary practice remain usable without this model.
  console.log("Local word alignment model is not prepared. Run node scripts/prepare-alignment.mjs --download, or set LIBITU_ALIGNMENT_MODEL to the pinned model file. Basic audio analysis remains available.");
  process.exit(process.argv.includes("--download") || process.env.LIBITU_ALIGNMENT_MODEL ? 1 : 0);
}
await copyFile(source, join(target, filename));
console.log("Prepared pinned local word alignment model for same-origin browser inference.");
