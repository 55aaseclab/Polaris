import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stylesheet = readFileSync(new URL("./web/styles.css", import.meta.url), "utf8");

test("shell pages reserve the root scrollbar gutter to avoid layout jumps", () => {
  assert.match(
    stylesheet,
    /html\.shell-scroll-root\s*\{[^}]*overflow-y:\s*auto;[^}]*scrollbar-gutter:\s*stable;[^}]*\}/s,
  );
});
