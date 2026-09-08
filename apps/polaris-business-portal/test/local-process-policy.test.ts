import assert from "node:assert/strict";
import test from "node:test";
import {
  THUMBNAIL_CONVERSION_MAX_BUFFER_BYTES,
  THUMBNAIL_CONVERSION_OPTIONS,
  THUMBNAIL_CONVERSION_TIMEOUT_MS,
  thumbnailConversionArgs,
} from "../lib/local-process-policy.js";

test("derived portal work has bounded time and child-process output", () => {
  assert.equal(THUMBNAIL_CONVERSION_TIMEOUT_MS, 5_000);
  assert.equal(THUMBNAIL_CONVERSION_MAX_BUFFER_BYTES, 64 * 1024);
  assert.deepEqual(THUMBNAIL_CONVERSION_OPTIONS, {
    encoding: "utf-8",
    maxBuffer: 64 * 1024,
    timeout: 5_000,
  });
});

test("thumbnail conversion constrains ImageMagick before tenant image input", () => {
  assert.deepEqual(
    thumbnailConversionArgs("/vault/workspaces/source.png", "/vault/workspaces/thumb.webp"),
    [
      "-limit", "memory", "128MiB",
      "-limit", "map", "256MiB",
      "-limit", "disk", "512MiB",
      "/vault/workspaces/source.png",
      "-auto-orient",
      "-thumbnail", "160x160^",
      "-gravity", "center",
      "-extent", "160x160",
      "-quality", "72",
      "/vault/workspaces/thumb.webp",
    ],
  );
});
