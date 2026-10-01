import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const source = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "libitu-reference-extension-"));
const extensionPath = join(temporary, "extension");
await cp(join(source, "src"), join(extensionPath, "src"), { recursive: true });
await cp(join(source, "icons"), join(extensionPath, "icons"), { recursive: true });
const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
// Test-only accelerator invokes Chrome's real extension action; production keeps its toolbar UI.
manifest.commands = { _execute_action: { suggested_key: { default: "Ctrl+Shift+Y", mac: "MacCtrl+Shift+Y" } } };
await writeFile(join(extensionPath, "manifest.json"), JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(join(temporary, "profile"), {
  headless: process.env.LIBITU_REFERENCE_HEADFUL !== "1",
  ...(process.env.LIBITU_CHROMIUM_PATH ? { executablePath: process.env.LIBITU_CHROMIUM_PATH } : { channel: "chromium" }),
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  viewport: { width: 1000, height: 700 }
});
const errors = [];
let step = "waiting for extension worker";
const deadline = setTimeout(() => {
  console.error(`Reference browser verification exceeded 60 seconds at: ${step}`);
  void context.close();
}, 60000);
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  worker.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://localhost:3000/**", (route) => route.fulfill({
    contentType: "text/html", body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Local tab audio fixture</title>
      <body><h1>Reference session fixture</h1><button id="prepare">Enable reference audio</button><pre id="status"></pre>
      <script>
        window.events = [];
        window.sendReference = (action, requestId = 'real-session', extra = {}) => window.postMessage({
          type:'LIBITU_REFERENCE_REQUEST',version:2,sessionId:'real-session',requestId,action,...extra
        }, location.origin);
        window.addEventListener('message', async (event) => {
          if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'LIBITU_REFERENCE_EVENT') return;
          window.events.push(event.data);
          document.getElementById('status').textContent = JSON.stringify(window.events.map(({status, error}) => ({status, error})));
          if (event.data.status === 'enabled') {
            window.lease = setInterval(() => sendReference('heartbeat'), 10000);
            sendReference('begin','clip-1',{sentenceId:'fixture-sentence-1',start:0,end:2});
          }
          if (event.data.status === 'recording') {
            const oscillator = fixtureAudio.createOscillator();
            oscillator.frequency.value = 440;
            const gain = fixtureAudio.createGain(); gain.gain.value = 0.2;
            oscillator.connect(gain).connect(fixtureAudio.destination);
            oscillator.start();
            setTimeout(() => { oscillator.stop(); sendReference('stop',event.data.requestId); }, 2000);
          }
          if (event.data.status === 'complete') {
            if (event.data.requestId === 'clip-1') {
              history.replaceState({},'',location.href.replace('fixture-sentence-1','fixture-sentence-2'));
              sendReference('begin','clip-2',{sentenceId:'fixture-sentence-2',start:2,end:4});
            } else sendReference('close');
          }
          if (event.data.status === 'closed' || (event.data.status === 'error' && event.data.requestId === 'real-session')) clearInterval(window.lease);
        });
        document.getElementById('prepare').onclick = async () => {
          window.fixtureAudio = new AudioContext(); await fixtureAudio.resume();
          sendReference('arm');
        };
      </script></body></html>`
  }));
  await page.goto("http://localhost:3000/?sourceUrl=https%3A%2F%2Fyoutu.be%2Ffixture&contentId=fixture-content");
  await page.evaluate(() => history.replaceState({}, "", `${location.href}&stage=2&segmentId=fixture-segment&sentenceId=fixture-sentence-1`));
  step = "arming";
  await page.click("#prepare");
  await page.waitForFunction(() => window.events.some((event) => ["armed", "error"].includes(event.status)));
  assert.equal(await page.evaluate(() => window.events.at(-1).status), "armed");
  const bridgeOnly = process.env.LIBITU_REFERENCE_BRIDGE_ONLY === "1";
  if (bridgeOnly) {
    step = "reading armed extension metadata";
    const armed = await worker.evaluate(async () => ({
      captures: await chrome.tabCapture.getCapturedTabs(),
      storage: await chrome.storage.session.get("libituReferenceSession")
    }));
    assert.equal(armed.captures.some((capture) => capture.status === "active"), false);
    assert.deepEqual(Object.keys(armed.storage.libituReferenceSession).sort(), ["documentId", "sessionId", "tabId"]);
    step = "cancelling armed reference";
    await page.evaluate(() => sendReference('close'));
    await page.waitForFunction(() => window.events.some((event) => event.status === "closed"));
    await page.evaluate(() => fixtureAudio.close());
  } else {
    await page.bringToFront();
    if (process.env.LIBITU_REFERENCE_MANUAL_ACTION !== "1") {
      await page.keyboard.press(process.env.LIBITU_REFERENCE_SHORTCUT ?? "Control+Shift+Y");
    }
    await page.waitForFunction(() => window.events.some((event) => ["closed", "error"].includes(event.status)), null, { timeout: 30000 });
  }
  const status = await page.evaluate(() => window.events.map(({ status, error }) => ({ status, error })));
  step = "decoding captured audio";
  assert.equal(status.at(-1).status, "closed", JSON.stringify(status));
  const decoded = bridgeOnly ? null : await page.evaluate(async () => {
    const results = [];
    for (const complete of window.events.filter((event) => event.status === "complete")) {
      const bytes = Uint8Array.from(atob(complete.audioBase64), (character) => character.charCodeAt(0));
      const buffer = await fixtureAudio.decodeAudioData(bytes.buffer);
      const samples = buffer.getChannelData(0);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      results.push({ requestId: complete.requestId, bytes: bytes.length, duration: buffer.duration, rms: Math.sqrt(sum / samples.length), mimeType: complete.mimeType });
    }
    await fixtureAudio.close();
    return results;
  });
  if (decoded) {
    assert.deepEqual(decoded.map((clip) => clip.requestId), ["clip-1", "clip-2"]);
    assert.equal(status.filter((event) => event.status === "enabled").length, 1);
    for (const clip of decoded) {
      assert.ok(clip.bytes > 1000);
      assert.ok(clip.duration >= 1.8 && clip.duration < 5);
      assert.ok(clip.rms > 0.01, `Captured silent audio: ${JSON.stringify(clip)}`);
    }
  }
  step = "verifying extension cleanup";
  const cleanup = await worker.evaluate(async () => ({
    offscreen: (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length,
    captures: await chrome.tabCapture.getCapturedTabs(),
    storage: await chrome.storage.session.get("libituReferenceSession")
  }));
  assert.equal(cleanup.offscreen, 0);
  assert.equal(cleanup.captures.some((capture) => capture.status === "active"), false);
  assert.deepEqual(cleanup.storage, {});
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status, decoded, cleanup: "no offscreen document or active stream; metadata removed", source: bridgeOnly
    ? "real unpacked v2 bridge arm/close only; toolbar gesture and actual tab capture remain unverified"
    : "one real Chrome session captures two local oscillator clips; no microphone, YouTube, or upload" }));
} catch (error) {
  console.error(JSON.stringify({ errors, pages: await Promise.all(context.pages().map(async (page) => ({
    url: page.url(), status: await page.locator("#status").allTextContents()
  }))) }));
  throw error;
} finally {
  clearTimeout(deadline);
  await context.close();
  await rm(temporary, { recursive: true, force: true });
}
