import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultVideoInput, parseVideoInput } from "../src/validate.js";
import { VideoError } from "../src/types.js";

describe("parseVideoInput contracts", () => {
  it("accepts a full seed script", () => {
    const input = defaultVideoInput({
      video_id: "demo-seed-v1",
      product_id: 1,
      bgm_path: "audio/bgm.m4a",
    });
    const parsed = parseVideoInput(input);
    assert.equal(parsed.purpose, "seed");
    assert.equal(parsed.script.beats.length, 4);
  });

  it("rejects incomplete purpose roles", () => {
    const input = defaultVideoInput({
      video_id: "demo-seed-v1",
      product_id: 1,
      bgm_path: "audio/bgm.m4a",
    });
    input.script.beats[1]!.role = "proof";
    assert.throws(() => parseVideoInput(input), VideoError);
  });

  it("requires bgm when require_bgm is true", () => {
    const input = defaultVideoInput({
      video_id: "demo-seed-v1",
      product_id: 1,
      bgm_path: "audio/bgm.m4a",
    });
    input.audio.bgm = null;
    assert.throws(() => parseVideoInput(input), /require_bgm/);
  });

  it("requires compare block for purpose=compare", () => {
    const input = defaultVideoInput({
      video_id: "demo-compare-v1",
      product_id: 1,
      bgm_path: "audio/bgm.m4a",
      purpose: "compare",
    });
    input.purpose = "compare";
    input.script.beats = [
      { role: "hook", text: "h", duration_sec: 3, motion: "zoom_in", image_slot: "near", image_path: null, asset_ref: null, trim: null },
      { role: "compare_a", text: "a", duration_sec: 3, motion: "static", image_slot: "near", image_path: null, asset_ref: null, trim: null },
      { role: "compare_b", text: "b", duration_sec: 3, motion: "static", image_slot: "near", image_path: null, asset_ref: null, trim: null },
      { role: "compare_vs", text: "v", duration_sec: 4, motion: "zoom_in", image_slot: "wear", image_path: null, asset_ref: null, trim: null },
      { role: "cta", text: "c", duration_sec: 3, motion: "static", image_slot: "near", image_path: null, asset_ref: null, trim: null },
    ];
    input.target.duration_sec = 16;
    input.compare = null;
    assert.throws(() => parseVideoInput(input), /compare/);
  });
});
