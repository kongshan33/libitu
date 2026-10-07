import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanCaptionText } from "../features/stage-one/api/caption-text.ts";

test("caption cues disappear while spoken words and punctuation remain", () => {
  assert.equal(cleanCaptionText(">> Well, first [clears throat] I say thanks."), "Well, first I say thanks.");
  assert.equal(cleanCaptionText("<< A [music] female business leader."), "A female business leader.");
  assert.equal(cleanCaptionText("[applause]"), "");
  assert.equal(cleanCaptionText("It's (really) 2 < 3, right?"), "It's (really) 2 < 3, right?");
});
