import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const manifestPath = join(root, "manifest.json");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const sidePanelSource = readFileSync(join(root, "src/sidepanel.js"), "utf8");

const requiredFiles = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...(manifest.content_scripts ?? []).flatMap((script) => script.js ?? []),
  "src/sidepanel.js",
  "src/sidepanel.css"
].filter(Boolean);

const errors = [];

if (manifest.manifest_version !== 3) {
  errors.push("manifest_version must be 3.");
}

if (!manifest.permissions?.includes("sidePanel")) {
  errors.push("sidePanel permission is required.");
}

if (!manifest.permissions?.includes("scripting")) {
  errors.push("scripting permission is required to recover missing content-script receivers.");
}

if (!sidePanelSource.includes("chrome.scripting.executeScript")) {
  errors.push("The side panel must recover when a YouTube tab has no content-script receiver.");
}

if (sidePanelSource.includes("analysis_version") || sidePanelSource.includes("ANALYSIS_VERSION")) {
  errors.push("The API server, not the extension, must own the analysis version.");
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
