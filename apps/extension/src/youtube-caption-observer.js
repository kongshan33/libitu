// Runs at document_start in YouTube's MAIN world. Observe responses the player
// already requested; never replay a URL, manufacture tokens or control playback.
(() => {
  "use strict";
  try {
    if (window !== window.top || window.location.origin !== "https://www.youtube.com"
      || (globalThis.__libituCaptionObserverV1?.version === 1
        && typeof globalThis.__libituCaptionObserverV1.read === "function")) return;

    const ownerDocument = document;
    const MAX_BYTES = 2 * 1024 * 1024;
    const MAX_CACHE_BYTES = 4 * 1024 * 1024;
    const TTL = 15 * 60_000;
    const COPY_DEADLINE = 2_000;
    const records = new Map();
    const copies = new Set();
    const xhrCleanups = new Set();
    const encoder = new TextEncoder();
    const parse = JSON.parse;
    const stringify = JSON.stringify;
    const apply = Reflect.apply;
    const now = Date.now.bind(Date);
    const later = setTimeout.bind(globalThis);
    const cancelTimer = clearTimeout.bind(globalThis);
    let generation = 0;
    let sequence = 0;
    let closed = false;
    let expiryTimer;
    let activeVideo = videoAtLocation();

    function languageCode(value) {
      if (typeof value !== "string" || value.length > 35) return undefined;
      const code = value.trim().replaceAll("_", "-").toLowerCase();
      return /^en(?:-[a-z0-9]{2,8})*$/.test(code) ? code : undefined;
    }
    function videoAtLocation() {
      try {
        const url = new URL(window.location.href);
        const id = url.searchParams.get("v");
        return url.origin === "https://www.youtube.com" && url.pathname === "/watch"
          && url.searchParams.getAll("v").length === 1 && /^[\w-]{11}$/.test(id ?? "") ? id : undefined;
      } catch { return undefined; }
    }
    function clearSource() {
      generation += 1;
      records.clear();
      cancelTimer(expiryTimer);
      expiryTimer = undefined;
      for (const copy of [...copies]) finish(copy);
      for (const cleanup of [...xhrCleanups]) { try { cleanup(); } catch { /* The page may replace event methods. */ } }
      activeVideo = videoAtLocation();
    }
    function syncLocation() {
      if (videoAtLocation() !== activeVideo) clearSource();
      return activeVideo;
    }
    function current(request) {
      return !closed && document === ownerDocument && request.generation === generation
        && request.videoId === videoAtLocation();
    }

    // Only the small identity survives this call. In particular, neither the
    // complete URL nor its signing / client parameters enters our cache.
    function identity(value, method = "GET") {
      if (typeof value !== "string" || typeof method !== "string" || method.toUpperCase() !== "GET") return undefined;
      const url = new URL(value, window.location.href);
      const params = url.searchParams;
      const videoId = params.get("v");
      const language = languageCode(params.get("lang"));
      const kind = params.get("kind") ?? "";
      const name = params.get("name") ?? "";
      if (url.origin !== "https://www.youtube.com" || url.pathname !== "/api/timedtext"
        || url.username || url.password || params.getAll("v").length !== 1 || !/^[\w-]{11}$/.test(videoId ?? "")
        || params.getAll("fmt").length !== 1 || params.get("fmt") !== "json3"
        || params.getAll("lang").length !== 1 || !language || params.has("tlang")
        || params.getAll("kind").length > 1 || params.getAll("name").length > 1 || kind.length > 32 || name.length > 200) return undefined;
      return { videoId, language, kind: kind === "asr" ? "asr" : !kind || kind === "manual" ? "manual" : "unknown",
        key: stringify([language, kind, name]) };
    }
    function start(metadata) {
      if (!metadata || closed || document !== ownerDocument || syncLocation() !== metadata.videoId) return undefined;
      return { ...metadata, generation, sequence: ++sequence };
    }
    function prune() {
      cancelTimer(expiryTimer);
      expiryTimer = undefined;
      const time = now();
      for (const [key, item] of records) if (item.expires <= time) records.delete(key);
      if (records.size) expiryTimer = later(prune, Math.max(1, Math.min(...[...records.values()].map((item) => item.expires)) - time));
    }
    function remember(request, status, captionTrack) {
      if (!current(request)) return;
      prune();
      const serialized = captionTrack ? stringify(captionTrack) : undefined;
      const bytes = serialized ? encoder.encode(serialized).byteLength : 0;
      if (bytes > MAX_BYTES) return remember(request, "response_too_large");
      const old = records.get(request.key);
      const hasOffsets = status === "ready";
      if (old?.serialized && !serialized || old?.hasOffsets && !hasOffsets
        || old?.sequence > request.sequence && old.hasOffsets === hasOffsets) return;
      records.set(request.key, { language: request.language, status, serialized, bytes, hasOffsets,
        sequence: request.sequence, expires: now() + TTL });
      try { window.dispatchEvent(new Event("libitu-caption-observer-update")); } catch { /* Page signal is best-effort. */ }
      while (records.size > 4 || [...records.values()].reduce((sum, item) => sum + item.bytes, 0) > MAX_CACHE_BYTES) {
        const [victim] = [...records].sort((left, right) => Number(left[1].hasOffsets) - Number(right[1].hasOffsets)
          || left[1].sequence - right[1].sequence);
        records.delete(victim[0]);
      }
      prune();
    }
    function read(videoId, language) {
      try {
        const code = languageCode(language);
        if (closed || document !== ownerDocument || !code || typeof videoId !== "string"
          || !/^[\w-]{11}$/.test(videoId) || syncLocation() !== videoId) return { status: "stale" };
        prune();
        const best = [...records.values()].sort((left, right) => Number(right.hasOffsets) - Number(left.hasOffsets)
          || Number(Boolean(right.serialized)) - Number(Boolean(left.serialized))
          || Number(right.language === code) - Number(left.language === code) || right.sequence - left.sequence)[0];
        return best ? { status: best.status, ...(best.serialized ? { captionTrack: parse(best.serialized) } : {}) }
          : { status: "not_observed" };
      } catch { return { status: "invalid_response" }; }
    }

    function finish(copy, status, track) {
      if (copy.done) return;
      copy.done = true;
      copies.delete(copy);
      cancelTimer(copy.timer);
      copy.text = "";
      if (copy.reader) {
        // A tee cancellation can wait for the player's branch. Never await it,
        // never abort the original fetch and never call xhr.abort().
        try { Promise.resolve(copy.reader.cancel()).catch(() => {}); } catch { /* Observation only. */ }
      }
      if (status) remember(copy.request, status, track);
    }
    function beginCopy(request) {
      if (!current(request) || copies.size >= 2) return undefined;
      const copy = { request, reader: undefined, text: "", done: false, deadline: now() + COPY_DEADLINE, timer: undefined };
      copies.add(copy);
      copy.timer = later(() => finish(copy, "observer_timeout"), COPY_DEADLINE);
      return copy;
    }
    function check(copy) {
      if (copy.done || !current(copy.request)) throw "stale";
      if (now() >= copy.deadline) throw "observer_timeout";
    }
    function failed(copy, error) {
      finish(copy, ["empty_response", "response_too_large", "observer_timeout", "stale"].includes(error) ? error : "invalid_response");
    }
    function sanitize(json, copy) {
      check(copy);
      if (!json || !Array.isArray(json.events)) throw "invalid_response";
      if (json.events.length > 10_000) throw "response_too_large";
      const validMs = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 604_800_000;
      let segments = 0;
      let characters = 0;
      let hasText = false;
      let hasOffsets = false;
      const events = [];
      for (const event of json.events) {
        check(copy);
        if (!Array.isArray(event?.segs) || !event.segs.length) continue;
        if (!validMs(event.tStartMs) || event.dDurationMs !== undefined && !validMs(event.dDurationMs)
          || event.aAppend !== undefined && ![0, 1].includes(event.aAppend)
          || event.wWinId !== undefined && (!Number.isSafeInteger(event.wWinId) || event.wWinId < 0)) throw "invalid_response";
        if (event.segs.length > 12_000) throw "response_too_large";
        const segs = [];
        for (const segment of event.segs) {
          if (typeof segment?.utf8 !== "string" || segment.tOffsetMs !== undefined && !validMs(segment.tOffsetMs)) throw "invalid_response";
          segments += 1;
          characters += segment.utf8.length;
          if (segments > 50_000 || characters > 240_000) throw "response_too_large";
          const text = Boolean(segment.utf8.trim());
          hasText ||= text;
          hasOffsets ||= text && segment.tOffsetMs !== undefined;
          segs.push({ utf8: segment.utf8, ...(segment.tOffsetMs !== undefined ? { tOffsetMs: segment.tOffsetMs } : {}) });
        }
        events.push({ tStartMs: event.tStartMs, segs,
          ...(event.dDurationMs !== undefined ? { dDurationMs: event.dDurationMs } : {}),
          ...(event.aAppend !== undefined ? { aAppend: event.aAppend } : {}),
          ...(event.wWinId !== undefined ? { wWinId: event.wWinId } : {}) });
      }
      if (!hasText) throw "empty_response";
      check(copy);
      const { videoId, language, kind } = copy.request;
      finish(copy, hasOffsets ? "ready" : "no_word_offsets",
        { version: "youtube-json3-v1", video_id: videoId, language, kind, events });
    }
    function parseText(text, copy) {
      check(copy);
      if (typeof text !== "string") throw "invalid_response";
      if (text.length > MAX_BYTES || encoder.encode(text).byteLength > MAX_BYTES) throw "response_too_large";
      if (!text.trim()) throw "empty_response";
      sanitize(parse(text), copy);
    }
    // XHR responseType=json has already been parsed by the browser. Count a
    // bounded JSON tree without allocating an unbounded JSON.stringify copy.
    function checkJsonSize(value, copy) {
      let bytes = 0;
      let nodes = 0;
      const seen = new WeakSet();
      function stringBytes(text) {
        bytes += 2;
        for (let index = 0; index < text.length; index += 1) {
          const code = text.charCodeAt(index);
          if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) bytes += 2;
          else if (code < 32) bytes += 6;
          else if (code < 128) bytes += 1;
          else if (code < 2048) bytes += 2;
          else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index += 1; }
          else bytes += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
          if (bytes > MAX_BYTES) throw "response_too_large";
          if (index % 1024 === 0) check(copy);
        }
      }
      function visit(item, depth) {
        if (++nodes > MAX_BYTES || depth > 64) throw "response_too_large";
        if (nodes % 256 === 0) check(copy);
        if (item === null) bytes += 4;
        else if (typeof item === "string") stringBytes(item);
        else if (typeof item === "number" && Number.isFinite(item)) bytes += String(item).length;
        else if (typeof item === "boolean") bytes += item ? 4 : 5;
        else if (typeof item === "object") {
          if (seen.has(item)) throw "invalid_response";
          seen.add(item);
          bytes += 2;
          let count = 0;
          if (Array.isArray(item)) {
            if (item.length > MAX_BYTES) throw "response_too_large";
            for (const child of item) { if (count++) bytes += 1; visit(child, depth + 1); }
          } else {
            for (const key in item) {
              const property = Object.getOwnPropertyDescriptor(item, key);
              if (!property) continue;
              if (!("value" in property)) throw "invalid_response";
              if (count++) bytes += 1;
              stringBytes(key); bytes += 1; visit(property.value, depth + 1);
            }
          }
        } else throw "invalid_response";
        if (bytes > MAX_BYTES) throw "response_too_large";
      }
      visit(value, 0);
      check(copy);
    }

    function sameResponse(request, url) {
      if (!url) return true;
      const actual = identity(url);
      return actual?.videoId === request.videoId && actual.key === request.key;
    }
    function observeFetch(request, response) {
      if (!current(request)) return;
      if (!response?.ok) { remember(request, "request_failed"); return; }
      if (response.redirected || !sameResponse(request, response.url)) { remember(request, "invalid_response"); return; }
      if (Number(response.headers?.get("content-length")) > MAX_BYTES) { remember(request, "response_too_large"); return; }
      const copy = beginCopy(request);
      if (!copy) return;
      try {
        const clone = response.clone();
        if (!clone.body) { finish(copy, "empty_response"); return; }
        copy.reader = clone.body.getReader();
      } catch { finish(copy, "invalid_response"); return; }
      void (async () => {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0;
        try {
          while (!copy.done) {
            const { value, done } = await copy.reader.read();
            check(copy);
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_BYTES) throw "response_too_large";
            copy.text += decoder.decode(value, { stream: true });
          }
          check(copy);
          copy.text += decoder.decode();
          parseText(copy.text, copy);
        } catch (error) { failed(copy, error); }
        finally { try { copy.reader.releaseLock(); } catch { /* Pending read/cancel owns the clone only. */ } }
      })();
    }

    globalThis.__libituCaptionObserverV1 = { version: 1, read };
    document.addEventListener("yt-navigate-start", clearSource);
    window.addEventListener("popstate", clearSource);
    window.addEventListener("pagehide", () => { closed = true; clearSource(); });
    window.addEventListener("pageshow", () => { if (closed) { closed = false; clearSource(); } });

    try {
      const previous = globalThis.fetch;
      const then = Promise.prototype.then;
      if (typeof previous === "function") globalThis.fetch = function (...args) {
        let request;
        try {
          const [input, init] = args;
          const method = init && Object.getOwnPropertyDescriptor(init, "method");
          if (!method || "value" in method) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href
              : typeof Request === "function" && input instanceof Request ? input.url : undefined;
            request = start(identity(url, method?.value ?? (typeof Request === "function" && input instanceof Request ? input.method : "GET")));
          }
        } catch { /* Do not coerce unusual caller arguments or change fetch errors. */ }
        const result = apply(previous, this, args);
        if (request) {
          try {
            const observation = apply(then, result, [(response) => { try { observeFetch(request, response); } catch { remember(request, "invalid_response"); } },
              () => { remember(request, "request_failed"); }]);
            // The observer branch must not create an unhandled rejection. The
            // caller still receives exactly the original promise below.
            apply(then, observation, [undefined, () => {}]);
          }
          catch { /* Another wrapper can return a non-native promise; leave it untouched. */ }
        }
        return result;
      };
    } catch { /* A page or another extension may own a non-writable hook. */ }

    try {
      const prototype = globalThis.XMLHttpRequest?.prototype;
      if (!prototype) return;
      const previousOpen = prototype.open;
      const previousSend = prototype.send;
      const states = new WeakMap();
      prototype.open = function (...args) {
        const result = apply(previousOpen, this, args);
        try {
          states.get(this)?.cleanup?.();
          states.set(this, { metadata: identity(typeof args[1] === "string" ? args[1] : args[1] instanceof URL ? args[1].href : undefined, args[0]) });
        } catch { states.delete(this); }
        return result;
      };
      prototype.send = function (...args) {
        const state = states.get(this);
        let request;
        try {
          if (state && !state.sent) {
            state.sent = true;
            request = start(state.metadata);
            if (request && xhrCleanups.size < 4) {
              const xhr = this;
              const cleanup = () => {
                xhrCleanups.delete(cleanup);
                state.cleanup = undefined;
                for (const event of ["load", "error", "abort", "timeout"]) xhr.removeEventListener(event, completed);
              };
              const completed = (event) => {
                let copy;
                try {
                  cleanup();
                  if (states.get(xhr) !== state || !current(request)) return;
                  if (event.type !== "load" || xhr.status < 200 || xhr.status >= 300) { remember(request, "request_failed"); return; }
                  if (!sameResponse(request, xhr.responseURL)) { remember(request, "invalid_response"); return; }
                  if (Number(xhr.getResponseHeader("content-length")) > MAX_BYTES) { remember(request, "response_too_large"); return; }
                  copy = beginCopy(request);
                  if (!copy) return;
                  if (xhr.responseType === "json") { checkJsonSize(xhr.response, copy); sanitize(xhr.response, copy); }
                  else if (!xhr.responseType || xhr.responseType === "text") parseText(xhr.responseText, copy);
                  else throw "invalid_response";
                } catch (error) {
                  try { if (copy) failed(copy, error); else remember(request, "invalid_response"); } catch { /* Never throw from a player event. */ }
                }
              };
              state.cleanup = cleanup;
              xhrCleanups.add(cleanup);
              for (const event of ["load", "error", "abort", "timeout"]) xhr.addEventListener(event, completed);
            }
          }
        } catch { try { if (request) state?.cleanup?.(); } catch { /* Preserve send if observation cannot be installed. */ } }
        try { return apply(previousSend, this, args); }
        catch (error) { try { if (request) state?.cleanup?.(); } catch { /* Preserve the original exception. */ } throw error; }
      };
    } catch { /* Never replace/freeze another extension's ownership of an API. */ }
  } catch { /* A MAIN-world observer is best-effort and must not break the page. */ }
})();
