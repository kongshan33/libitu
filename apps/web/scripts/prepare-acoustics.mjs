import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "public/acoustic-assets/local-acoustics-v1");
const assets = [
  { package: "@ricky0123/vad-web", version: "0.0.29", file: "silero_vad_v5.onnx", sha256: "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f" },
  { package: "onnxruntime-web", version: "1.22.0", file: "ort-wasm-simd-threaded.mjs", sha256: "30dd851d9c00622940500f71ddd2ff8820c5cb65270816080175b958705385a8" },
  { package: "onnxruntime-web", version: "1.22.0", file: "ort-wasm-simd-threaded.wasm", sha256: "71aef04959c5c1b6de461b6538e2058e306610034a85aad2742d0c7fd4533fe4" },
];

await mkdir(target, { recursive: true });
for (const asset of assets) {
  const dist = dirname(require.resolve(asset.package));
  const metadata = JSON.parse(await readFile(join(dist, "../package.json"), "utf8"));
  if (metadata.version !== asset.version) throw new Error(`Unexpected ${asset.package} version; update the acoustic manifest deliberately.`);
  const bytes = await readFile(join(dist, asset.file));
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error(`Acoustic asset integrity failed: ${asset.file}`);
  let existing;
  try { existing = await readFile(join(target, asset.file)); } catch { /* First build. */ }
  if (!existing || !existing.equals(bytes)) await writeFile(join(target, asset.file), bytes);
}
await writeFile(join(target, "manifest.json"), `${JSON.stringify({ version: "local-acoustics-v1", assets }, null, 2)}\n`);
await copyFile(join(root, "features/stage-two/acoustics/THIRD_PARTY_LICENSES.txt"), join(target, "LICENSES.txt"));
await copyFile(join(root, "scripts/acoustic-licenses/onnxruntime-THIRD-PARTY-NOTICES.txt"), join(target, "onnxruntime-THIRD-PARTY-NOTICES.txt"));
console.log("Prepared pinned local acoustic assets (no network requests).");
