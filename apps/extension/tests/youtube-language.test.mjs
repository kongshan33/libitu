import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const background = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
const code = background.slice(background.indexOf("function inspectYouTubeLanguage("),
  background.indexOf("\nfunction normalizeLanguageCode("));
const videoId = "-sKAMB10eh0";
const automatic = (languageCode) => ({ languageCode, kind: "asr", vssId: `a.${languageCode}` });
function inspect(captions, details = {}, meta) {
  const response = { videoDetails: { videoId, ...details }, captions: { playerCaptionsTracklistRenderer: captions } };
  return runInNewContext(`${code}; inspectYouTubeLanguage('${videoId}')`, {
    URL, window: { location: { href: `https://www.youtube.com/watch?v=${videoId}` } },
    document: { querySelector: (selector) => selector === "#movie_player"
      ? { getPlayerResponse: () => response }
      : meta ? { getAttribute: () => meta } : null }
  });
}
function dubbedTracks() {
  // Sanitized structure observed on the reported Lisa Su video. Every audio
  // track has a caption default; the explicit audio index points to English.
  return {
    captionTracks: ["ar", "bn", "nl-NL", "en"].map(automatic),
    audioTracks: ["bn.10", "de-DE.10", "fr-FR.10", "uk.10", "en-US.4"].map((audioTrackId) => ({
      audioTrackId, hasDefaultTrack: true, defaultCaptionTrackIndex: 3, captionTrackIndices: [0, 1, 2, 3]
    })),
    defaultAudioTrackIndex: 4
  };
}

test("multilingual ASR uses the explicit audio default, independent of caption order", () => {
  const captions = dubbedTracks();
  assert.equal(inspect(captions).languageCode, "en-us");
  assert.equal(inspect(captions).source, "audio-track");
  captions.captionTracks.reverse();
  assert.equal(inspect(captions).languageCode, "en-us");
});

test("English captions do not override a non-English default audio or explicit video language", () => {
  const captions = dubbedTracks();
  captions.defaultAudioTrackIndex = 0;
  assert.equal(inspect(captions).languageCode, "bn");
  captions.defaultAudioTrackIndex = 4;
  assert.equal(inspect(captions, { defaultAudioLanguage: "fr" }).languageCode, "fr");
});

test("ambiguous multilingual ASR abstains when the audio default cannot be identified", () => {
  for (const defaultAudioTrackIndex of [undefined, -1, 99, "4"]) {
    assert.equal(inspect({ ...dubbedTracks(), defaultAudioTrackIndex }), undefined);
  }
  const captions = dubbedTracks();
  captions.audioTracks[4].audioTrackId = "unknown";
  assert.equal(inspect(captions), undefined);
});

test("single automatic source still wins over translated default captions", () => {
  assert.equal(inspect({ captionTracks: [automatic("ja"), { languageCode: "en" }],
    audioTracks: [{ defaultCaptionTrackIndex: 1 }] }).languageCode, "ja");
  assert.equal(inspect({ captionTracks: [automatic("en"), automatic("en")] }).languageCode, "en");
});

test("single audio and unambiguous marked audio retain compatibility without an explicit index", () => {
  assert.equal(inspect({ ...dubbedTracks(), defaultAudioTrackIndex: undefined,
    audioTracks: [{ audioTrackId: "en-US.4" }] }).languageCode, "en-us");
  assert.equal(inspect({ ...dubbedTracks(), defaultAudioTrackIndex: undefined,
    audioTracks: [{ audioTrackId: "ar.10" }, { audioTrackId: "en-US.4", hasDefaultTrack: true }] }).languageCode, "en-us");
});

test("manual-only, missing, malformed and stale metadata remain bounded", () => {
  assert.equal(inspect({ captionTracks: [{ languageCode: "en" }] }).languageCode, "en");
  assert.equal(inspect({}), undefined);
  assert.equal(inspect({ captionTracks: [automatic("en")] }, {}, "not a language").languageCode, "en");
  assert.equal(inspect(dubbedTracks(), { videoId: "other-video" }), undefined);
});
