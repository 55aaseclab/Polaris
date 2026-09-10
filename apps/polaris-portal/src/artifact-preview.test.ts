import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactPreviewKind,
  artifactPreviewSource,
  artifactPreviewUrl,
  formatJsonArtifact,
} from "./artifact-preview.js";

test("classifies common artifact formats for native previews", () => {
  assert.equal(artifactPreviewKind("report.pdf"), "pdf");
  assert.equal(artifactPreviewKind("photo.webp"), "image");
  assert.equal(artifactPreviewKind("demo.mp4"), "video");
  assert.equal(artifactPreviewKind("audio.wav"), "audio");
  assert.equal(artifactPreviewKind("rows.csv"), "table");
  assert.equal(artifactPreviewKind("result.json"), "json");
  assert.equal(artifactPreviewKind("notes.md"), "markdown");
  assert.equal(artifactPreviewKind("unknown.bin"), "binary");
});

test("only treats safe URL-like content as a media preview source", () => {
  assert.equal(artifactPreviewSource("https://example.invalid/report.pdf"), "https://example.invalid/report.pdf");
  assert.equal(artifactPreviewSource("data:image/png;base64,fixture"), "data:image/png;base64,fixture");
  assert.equal(artifactPreviewSource("Binary artifact\nname: report.pdf"), null);
});

test("builds a protected artifact preview URL", () => {
  assert.equal(
    artifactPreviewUrl("run/example", "artifact/report.pdf"),
    "/api/workflow-runs/run%2Fexample/artifacts/artifact%2Freport.pdf",
  );
});

test("pretty prints valid JSON without changing invalid text", () => {
  assert.equal(formatJsonArtifact('{"ok":true,"count":2}'), '{\n  "ok": true,\n  "count": 2\n}');
  assert.equal(formatJsonArtifact("not json"), "not json");
});
