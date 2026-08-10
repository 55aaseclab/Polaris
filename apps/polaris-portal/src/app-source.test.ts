import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

test("user page keeps session as a peer section beside profile and credentials", () => {
  assert.match(appSource, /<section className="peer-section"><h2>会话<\/h2>/u);
  assert.doesNotMatch(appSource, /<Card>\s*<CardHeader>\s*<CardTitle>会话/u);
});
