import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const item = {
  kind: "idiom", text: "double down on", source_text: "doubled down on",
  meaning: "Increase commitment.", usage_note: "Use to describe stronger commitment.",
  tags: ["idiom"], timestamp: "0:01", level: "B2", register: "professional",
  naturalness_score: 4, transferability_score: 4, learning_value_score: 4
};
const preview = {
  output_chars: 1000, summary: "A discussion of commitment.", chapters: ["Commitment"],
  logic_flow: [{ title: "Explaining commitment", subtitle: "Support the plan.", timestamp: "0:01" }],
  corpus_items: [item], transcript_lines: [{ time: "0:01", text: "They doubled down on the plan." }]
};
const job = {
  id: "render-test", content_id: "render-content", status: "processing", analysis_version: "mvp-v6",
  processing_stage: "analyzing", blueprint_id: null, error_message: null, analysis_preview: preview
};
const blueprint = {
  id: "render-blueprint", content_id: job.content_id, title: "Rendering regression test",
  source_url: "https://www.youtube.com/watch?v=render-test", summary: preview.summary, chapters: preview.chapters,
  logic_flow: [{ id: "logic-1", title: preview.logic_flow[0].title, subtitle: "Support the plan.", time: "0:01" }],
  corpus_items: [{ ...item, id: "idiom-9", text: `"${item.text}" - ${item.meaning}`, meta: "0:01 - B2 - click + to save" }],
  transcript: [{ id: "logic-1", time: "0:01", parts: [preview.transcript_lines[0].text] }]
};

const selectionAnalysis = (text, index) => ({
  analysis_source: "ai", selection_type: "phrase", completeness: "complete",
  selected_text: text, recommended_text: text, recommendation_reason: "",
  fields: { kind: "chunk", tags: ["discourse"], level: "B1", register: "neutral" },
  note_placeholder: "Optional note",
  explanation: {
    pronunciation: { ipa: "", connected_speech: "", audio_text: text },
    meaning: `Selection result ${index}`, pragmatic_function: "Contextual meaning.",
    similar_expressions: [], examples: [], usage_chips: []
  },
  syntax_analysis: {
    sentence_type: "Phrase", main_clause: text, structure_breakdown: [], logic_relations: [],
    information_hierarchy: [], style_features: [], usage_scenarios: [], grammar_points: [],
    wording_notes: [], reusable_patterns: [], translations: [], translation_notes: [], evidence: []
  }
});

async function selectText(page, text) {
  await page.locator(".transcript-text").first().scrollIntoViewIfNeeded();
  await page.locator(".transcript-text").first().evaluate((element, selected) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const start = element.textContent.indexOf(selected);
    if (start < 0) throw new Error(`Missing selected text: ${selected}`);
    const range = document.createRange();
    let offset = 0;
    let started = false;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const end = offset + node.textContent.length;
      if (!started && start >= offset && start < end) {
        range.setStart(node, start - offset);
        started = true;
      }
      if (started && start + selected.length <= end) {
        range.setEnd(node, start + selected.length - offset);
        break;
      }
      offset = end;
    }
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, text);
  await page.locator(".selection-original").filter({ hasText: text }).waitFor();
}

const browser = await chromium.launch({ headless: true, channel: process.env.LIBITU_BROWSER_CHANNEL ?? "chrome" });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const counts = { jobs: 0, blueprints: 0 };
    let selectionCount = 0;
    let delayedSelectionRoute;
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
      if (url.pathname.startsWith("/api/")) {
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (url.pathname === "/api/corpus/analyze-selection") {
          selectionCount += 1;
          if (selectionCount === 1) { delayedSelectionRoute = route; return; }
          return route.fulfill({ json: selectionAnalysis(route.request().postDataJSON().selected_text, selectionCount), headers });
        }
        if (url.pathname === "/api/jobs/render-test") {
          counts.jobs += 1;
          return route.fulfill({ json: job, headers });
        }
        if (url.pathname === "/api/blueprints/render-content") {
          counts.blueprints += 1;
          return route.fulfill({ json: blueprint, headers });
        }
        throw new Error(`Unexpected API call: ${url.pathname}`);
      }
      if (url.origin === origin) return route.continue();
      if (url.hostname.endsWith(".clerk.accounts.dev")) return route.continue();
      // Use anonymous Clerk initialization; video and analysis remain mocked.
      return route.fulfill({ status: 200, contentType: "text/plain", body: "" });
    });
    await page.addInitScript(() => {
      window.__streams = [];
      window.EventSource = class extends EventTarget {
        closed = false;
        constructor() { super(); window.__streams.push(this); }
        close() { this.closed = true; }
      };
      window.YT = { Player: class {
        constructor(_element, { events }) { queueMicrotask(() => events.onReady()); }
        getCurrentTime() { return 0; }
        seekTo() {}
        playVideo() {}
        destroy() {}
      } };
    });
    await page.goto(`${origin}/?${new URLSearchParams({
      sourceUrl: blueprint.source_url, title: blueprint.title,
      contentId: job.content_id, jobId: job.id, learnerLevel: "B2"
    })}#transcript-0-01`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__streams.length === 1);
    await page.getByRole("button", { name: "Idioms", exact: true }).click();
    await page.locator(".corpus-card").waitFor();
    await page.locator(".youtube-player iframe").waitFor();
    const card = await page.locator(".corpus-card").elementHandle();
    const logic = await page.locator(".logic-node").elementHandle();
    const transcript = await page.locator(".transcript-line").elementHandle();
    const iframe = await page.locator(".youtube-player iframe").elementHandle();
    await page.locator(".logic-node").click();
    await page.evaluate((ready) => {
      window.__streams[0].dispatchEvent(Object.assign(new Event("job"), { data: JSON.stringify(ready) }));
    }, { ...job, status: "ready", processing_stage: "completed", analysis_preview: null });
    await page.locator(".save-button:not([disabled])").waitFor();
    const returnUrl = page.url();
    await page.evaluate(() => {
      window.__authCalls = [];
      window.__originalOpenSignIn = window.Clerk.openSignIn;
      window.__originalOpenSignUp = window.Clerk.openSignUp;
      window.Clerk.openSignIn = (options) => window.__authCalls.push({ mode: "sign-in", options });
      window.Clerk.openSignUp = (options) => window.__authCalls.push({ mode: "sign-up", options });
    });
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const createAccount = page.getByRole("button", { name: "Create account", exact: true });
    await createAccount.hover();
    assert.deepEqual(await createAccount.evaluate((button) => ({
      background: getComputedStyle(button).backgroundColor,
      color: getComputedStyle(button).color
    })), { background: "rgb(60, 52, 137)", color: "rgb(255, 255, 255)" });
    await page.screenshot({ path: `/tmp/libitu-auth-hover-${viewport.width}.png`, fullPage: true });
    await createAccount.click();
    assert.deepEqual(await page.evaluate(() => window.__authCalls), [
      { mode: "sign-in", options: { forceRedirectUrl: returnUrl, signUpForceRedirectUrl: returnUrl } },
      { mode: "sign-up", options: { forceRedirectUrl: returnUrl, signInForceRedirectUrl: returnUrl } }
    ]);
    await page.evaluate(() => {
      window.Clerk.openSignIn = window.__originalOpenSignIn;
      window.Clerk.openSignUp = window.__originalOpenSignUp;
    });
    for (const [node, selector] of [[card, ".corpus-card"], [logic, ".logic-node"], [transcript, ".transcript-line"], [iframe, ".youtube-player iframe"]]) {
      assert.equal(await node.evaluate((element, css) => element.isConnected && element === document.querySelector(css), selector), true, `${selector} must survive finalization`);
    }
    assert.equal(await page.locator(".logic-node.active").count(), 1);
    assert.deepEqual(counts, { jobs: 1, blueprints: 1 });
    assert.equal(await page.evaluate(() => window.__streams.length === 1 && window.__streams[0].closed), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(await page.getByText("Chapters", { exact: true }).count(), 0);

    await selectText(page, "doubled down on");
    await page.mouse.click(3, 3);
    assert.equal(await page.locator(".selection-card").count(), 0, "outside click dismisses a loading card");
    await selectText(page, "doubled down on");
    await page.getByText("Selection result 2", { exact: true }).waitFor();
    await page.locator(".selection-note").fill("A note on the old card");
    assert.equal(await page.locator(".selection-card").count(), 1, "inside clicks preserve the card");
    await page.getByRole("button", { name: "Pin selection card", exact: true }).click();
    await page.mouse.click(3, 3);
    assert.equal(await page.getByRole("button", { name: "Unpin selection card" }).getAttribute("aria-pressed"), "true");
    const oldSelectionCard = await page.locator(".selection-card").elementHandle();
    await selectText(page, "the plan");
    await page.getByText("Selection result 3", { exact: true }).waitFor();
    assert.equal(await oldSelectionCard.evaluate((element) => element.isConnected), false, "a new selection destroys the pinned card");
    assert.equal(await page.locator(".selection-note").inputValue(), "");
    assert.equal(await page.getByRole("button", { name: "Pin selection card", exact: true }).getAttribute("aria-pressed"), "false");
    await selectText(page, "doubled down on");
    await page.getByText("Selection result 4", { exact: true }).waitFor();
    assert.equal(await page.locator(".selection-card").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    }), true, "selection card stays within the viewport horizontally");
    const delayedResponse = page.waitForResponse((response) => response.url().endsWith("/analyze-selection"));
    await delayedSelectionRoute.fulfill({
      json: selectionAnalysis("doubled down on", 1),
      headers: { "access-control-allow-origin": "*" }
    });
    await delayedResponse;
    await page.getByRole("button", { name: "Pin selection card", exact: true }).click();
    await page.getByRole("button", { name: "Unpin selection card", exact: true }).click();
    assert.equal(await page.getByText("Selection result 4", { exact: true }).count(), 1, "late results cannot replace a newer card for the same text");
    await page.screenshot({ path: `/tmp/libitu-selection-${viewport.width}.png`, fullPage: true });
    await page.mouse.click(3, 3);
    assert.equal(await page.locator(".selection-card").count(), 0, "unpin restores outside dismissal");
    await page.getByRole("button", { name: "Save to corpus", exact: true }).click();
    await page.getByRole("button", { name: "Saved", exact: true }).click();
    await page.getByRole("button", { name: "Remove from corpus", exact: true }).waitFor();
    assert.match(await page.locator(".save-button svg").getAttribute("class"), /trash/);
    assert.equal(await page.locator(".save-button .lucide-plus").count(), 0);
    const panelLayout = await page.locator(".right-panel").evaluate((panel) => ({
      width: panel.clientWidth, scrollWidth: panel.scrollWidth, scrollLeft: panel.scrollLeft,
      children: [...panel.children].map((child) => ({ className: child.className, width: child.clientWidth, scrollWidth: child.scrollWidth }))
    }));
    assert.equal(panelLayout.scrollWidth <= panelLayout.width && panelLayout.scrollLeft === 0, true, JSON.stringify(panelLayout));
    const tabLayout = await page.locator(".corpus-tab").evaluateAll((tabs) => tabs.map((tab) => ({ text: tab.textContent, width: tab.clientWidth, scrollWidth: tab.scrollWidth })));
    assert.equal(tabLayout.every((tab) => tab.scrollWidth <= tab.width), true, JSON.stringify(tabLayout));
    await page.screenshot({ path: `/tmp/libitu-render-${viewport.width}.png`, fullPage: true });
    await page.evaluate(() => {
      const value = JSON.parse(localStorage.getItem("libitu:corpus:v1"));
      const record = value.guest[0];
      // A manual save made during streaming may know only the source URL.
      const key = JSON.parse(record.key);
      key[0] = record.sourceUrl;
      record.key = JSON.stringify(key);
      delete record.contentId;
      value.guest[0].item.text = "Edited saved expression";
      localStorage.setItem("libitu:corpus:v1", JSON.stringify(value));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__streams.length === 1);
    await page.getByRole("button", { name: "Saved", exact: true }).click();
    await page.getByRole("button", { name: "Remove from corpus", exact: true }).waitFor();
    assert.equal(await page.getByText("Edited saved expression", { exact: true }).count(), 1);
    assert.match(await page.locator(".save-button svg").getAttribute("class"), /trash/);
    await page.getByRole("button", { name: "Remove from corpus", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".corpus-card").length === 0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__streams.length === 1);
    await page.getByRole("button", { name: "Saved", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".corpus-sync-status"));
    assert.equal(await page.locator(".corpus-card").count(), 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ viewport, counts, preservedNodes: 4, errors }));
    await context.close();
  }
} finally {
  await browser.close();
}
