import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const manifestPath = join(root, "manifest.json");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const backgroundSource = readFileSync(join(root, manifest.background.service_worker), "utf8");

const requiredFiles = [
  manifest.background?.service_worker,
  ...(manifest.content_scripts ?? []).flatMap((script) => script.js ?? []),
  ...(manifest.web_accessible_resources ?? []).flatMap((group) => group.resources ?? []),
].filter(Boolean);

const errors = [];

if (manifest.manifest_version !== 3) {
  errors.push("manifest_version must be 3.");
}

if (!manifest.permissions?.includes("scripting")) {
  errors.push("scripting permission is required to recover missing content-script receivers.");
}

if (!backgroundSource.includes("chrome.scripting.executeScript")) {
  errors.push("The launcher must recover when a YouTube tab has no content-script receiver.");
}

if (/analysis_version|ANALYSIS_VERSION/.test(backgroundSource)) {
  errors.push("The API server, not the extension, must own the analysis version.");
}

if (manifest.permissions?.includes("sidePanel") || manifest.side_panel || /chrome\.sidePanel/.test(backgroundSource)) {
  errors.push("The extension must not expose a side panel.");
}

if (manifest.action?.default_popup || !backgroundSource.includes("chrome.action.onClicked")) {
  errors.push("The toolbar action must launch Stage 1 directly.");
}

if (!backgroundSource.includes("SUPPORTED_LANGUAGE_BASES") || !backgroundSource.includes("LIBITU_GET_VIDEO_LANGUAGE_SUPPORT")) {
  errors.push("Both extension entries must use the explicit video-language support gate.");
}

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) {
    errors.push(`Missing extension file: ${file}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(
  join(root, "dist", "extension-build.json"),
  `${JSON.stringify({ validatedAt: new Date().toISOString(), manifestVersion: manifest.version }, null, 2)}\n`
);

console.log(`Extension manifest is valid with ${requiredFiles.length} referenced files.`);
