import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const source = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "libitu-v4-"));
const extensionPath = join(temporary, "extension");
await cp(join(source, "src"), join(extensionPath, "src"), { recursive: true });
await cp(join(source, "icons"), join(extensionPath, "icons"), { recursive: true });
const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
manifest.commands = { _execute_action: { suggested_key: { default: "Ctrl+Shift+Y", mac: "MacCtrl+Shift+Y" } } };
await writeFile(join(extensionPath, "manifest.json"), JSON.stringify(manifest));
const contentId = "a0000000-0000-4000-8000-000000000001";
const context = await chromium.launchPersistentContext(join(temporary, "profile"), {
  headless: process.env.LIBITU_V4_HEADFUL !== "1",
  ...(process.env.LIBITU_CHROMIUM_PATH ? { executablePath: process.env.LIBITU_CHROMIUM_PATH } : { channel: "chromium" }),
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});
let page;
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  // Only the public content metadata response is a fixture. Sender document IDs,
  // isolated content scripts, action gesture and tabCapture are Chrome's real APIs.
  await worker.evaluate(id => {
    globalThis.__bufferSenders = [];
    globalThis.__identityReads = 0;
    globalThis.__identityGate = new Promise(resolve => { globalThis.__releaseIdentity = resolve; });
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (message?.type === "LIBITU_BUFFER_REQUEST") globalThis.__bufferSenders.push({ action: message.action, url: sender.url, tabUrl: sender.tab?.url, documentId: sender.documentId, tabId: sender.tab?.id });
      return false;
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url) !== `http://localhost:8000/api/content/${id}/identity`) return realFetch(url, init);
      globalThis.__identityReads++;
      await globalThis.__identityGate;
      return Response.json({ content_id: id, kind: "youtube", source_url: "https://www.youtube.com/watch?v=first-video" });
    };
  }, contentId);
  page = await context.newPage();
  await page.route("http://localhost:3000/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html>
    <title>v4 workspace fixture</title><button id="enable">Enable audio</button><pre id="status"></pre><script>
    window.events=[];
    window.send=(action, extra={})=>postMessage({type:'LIBITU_BUFFER_REQUEST',version:4,contentId:'${contentId}',videoId:'first-video',sessionId:'capture-session',requestId:'capture-session',action,...extra},location.origin);
    addEventListener('message',event=>{if(event.source!==window||event.origin!==location.origin||event.data?.type!=='LIBITU_BUFFER_EVENT')return;
      events.push(event.data);document.querySelector('#status').textContent=JSON.stringify(events.map(({status,error})=>({status,error})));
    });
    document.querySelector('#enable').onclick=async()=>{
      if (${process.env.LIBITU_V4_CAPTURE === "1"}) {
        window.audio=new AudioContext();await audio.resume();window.oscillator=audio.createOscillator();
        const gain=audio.createGain();gain.gain.value=.15;oscillator.connect(gain).connect(audio.destination);oscillator.start();
      }
      send('arm');
    };
    </script>` }));
  await page.goto("http://localhost:3000/practice/import?sourceUrl=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dfirst-video");
  await page.evaluate(id => history.replaceState(null, "", `/practice/${id}`), contentId);
  await page.evaluate(() => {
    for (const version of [2,3]) send('arm',{version});
    postMessage({type:'LIBITU_REFERENCE_REQUEST',version:2,sessionId:'obsolete',requestId:'obsolete',action:'arm'},location.origin);
  });
  await page.waitForTimeout(250);
  assert.deepEqual(await worker.evaluate(() => chrome.storage.session.get("libituBufferedSession")), {});
  await page.evaluate(() => send('ping'));
  await page.waitForFunction(() => events.some(event => event.status === 'available'));
  assert.equal(await worker.evaluate(() => globalThis.__identityReads), 0, 'ping is independent of backend latency');
  await page.click("#enable");
  await assertEventually(async () => assert.equal(await worker.evaluate(() => globalThis.__identityReads), 1));
  assert.equal(await page.evaluate(() => events.some(event => event.status === 'armed')), false);
  assert.equal(await worker.evaluate(async () => chrome.action.getBadgeText({ tabId: globalThis.__bufferSenders.find(message => message.action === 'arm').tabId })), '', 'ON? waits for real arming');
  await worker.evaluate(() => globalThis.__releaseIdentity());
  await page.waitForFunction(() => events.some(e=>e.status==='armed'||e.status==='error'));
  assert.equal(await page.evaluate(() => events.at(-1).status), "armed");
  assert.equal(await worker.evaluate(() => globalThis.__identityReads), 1, 'one identity request per initial arm');
  assert.equal(await worker.evaluate(async () => chrome.action.getBadgeText({ tabId: globalThis.__bufferSenders.find(message => message.action === 'arm').tabId })), 'ON?');
  const initialSender = await worker.evaluate(() => globalThis.__bufferSenders.find(message => message.action === "arm"));
  assert.equal(new URL(initialSender.url).pathname, "/practice/import");
  assert.equal(new URL(initialSender.tabUrl).pathname, `/practice/${contentId}`);
  assert.equal(await worker.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).some(c=>c.status==='active')),false);
  let clip = null;
  const capture = process.env.LIBITU_V4_CAPTURE === "1";
  if (capture) {
  await page.bringToFront();
  await page.keyboard.press("Control+Shift+Y");
  await page.waitForFunction(() => events.some(e=>e.status==='enabled'||e.status==='error'), null, { timeout: 12000 });
  assert.equal(await page.evaluate(() => events.at(-1).status),"enabled", await page.locator('#status').innerText());
  const session = await worker.evaluate(async () => (await chrome.storage.session.get('libituBufferedSession')).libituBufferedSession);
  await page.evaluate(id => {
    history.pushState({},'',`/practice/${id}/segments?segmentId=s&step=prepare`);
    history.pushState({},'',`/practice/${id}/shadow?segmentId=s&sentenceId=n&learnerLevel=B2`);
    window.started=performance.now();
    window.samples=setInterval(()=>send('observe',{telemetry:{epochTime:performance.timeOrigin+performance.now(),wallTime:performance.now(),time:10+(performance.now()-started)/1000,rate:1,state:1,generation:1}}),80);
  }, contentId);
  await page.waitForFunction(() => events.some(e=>e.status==='coverage'&&e.retainedBytes>32000),null,{timeout:12000});
  assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.session.get('libituBufferedSession')).libituBufferedSession),session);
  await page.evaluate(()=>{const r=events.findLast(e=>e.status==='coverage'&&e.ranges.length)?.ranges[0];send('extract',{requestId:'clip-1',start:r.start+.1,end:r.start+.5});});
  await page.waitForFunction(()=>events.some(e=>e.requestId==='clip-1'&&e.status==='complete'),null,{timeout:12000});
  clip = await page.evaluate(async()=>{
    const e=events.find(e=>e.status==='complete');const bytes=Uint8Array.from(atob(e.audioBase64),x=>x.charCodeAt(0));
    const pcm=await audio.decodeAudioData(bytes.buffer);const samples=pcm.getChannelData(0);
    return {duration:pcm.duration,rms:Math.sqrt(samples.reduce((sum,s)=>sum+s*s,0)/samples.length)};
  });
  assert.ok(clip.duration>.39&&clip.duration<.41);assert.ok(clip.rms>.01,JSON.stringify(clip));
  } else {
    const session = await worker.evaluate(async () => (await chrome.storage.session.get('libituBufferedSession')).libituBufferedSession);
    await page.evaluate(id => {
      history.pushState({}, '', `/practice/${id}/segments?segmentId=s&step=prepare`);
      history.pushState({}, '', `/practice/${id}/shadow?segmentId=s&sentenceId=n`);
      send('arm');
    }, contentId);
    await page.waitForFunction(() => events.filter(event => event.status === 'armed').length === 2);
    assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.session.get('libituBufferedSession')).libituBufferedSession), session);
    await page.evaluate(id => history.replaceState(null, '', `/practice/${id}/shadow?segmentId=s&sentenceId=next`), contentId);
    await page.waitForTimeout(300);
    assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.session.get('libituBufferedSession')).libituBufferedSession), session);
  }
  await page.reload();
  await page.waitForFunction(()=>events.length===0);
  await assertEventually(async()=>assert.deepEqual(await worker.evaluate(()=>chrome.storage.session.get('libituBufferedSession')),{}));
  const released=await worker.evaluate(async()=>({offscreen:(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length,active:(await chrome.tabCapture.getCapturedTabs()).some(c=>c.status==='active')}));
  assert.deepEqual(released,{offscreen:0,active:false});
  await page.evaluate(() => send('arm'));
  await page.waitForFunction(() => events.some(event => event.status === 'armed' || event.status === 'error'));
  assert.equal(await page.evaluate(() => events.at(-1).status), 'armed', 'cold content document can arm after reload');
  await page.evaluate(() => send('close'));
  await page.waitForFunction(() => events.some(event => event.status === 'closed'));
  console.log(JSON.stringify({importNavigation:'armed with original sender URL',coldContent:'armed after reload',protocol:4,oldVersions:'rejected',grant:capture?'real Chrome action':'not exercised; arm does not authorize capture',sameContent:'retained across paths',clip,reload:'released'}));
} catch(error) {
  const worker = context.serviceWorkers()[0];
  if (worker) console.error(await worker.evaluate(() => globalThis.__bufferSenders));
  if(page&&!page.isClosed()) console.error(await page.locator('#status').innerText().catch(()=>''));
  throw error;
} finally { await context.close();await rm(temporary,{recursive:true,force:true}); }
async function assertEventually(check) { for(let i=0;i<40;i++){try{return await check();}catch(error){if(i===39)throw error;await new Promise(resolve=>setTimeout(resolve,100));}} }
