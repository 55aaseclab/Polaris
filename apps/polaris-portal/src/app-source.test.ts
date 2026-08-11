import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const htmlSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("./index.css", import.meta.url), "utf8");

test("user page keeps session as a peer section beside profile and credentials", () => {
  assert.match(appSource, /<section className="peer-section"><h2>会话<\/h2>/u);
  assert.doesNotMatch(appSource, /<Card>\s*<CardHeader>\s*<CardTitle>会话/u);
});

test("Portal declares and owns a light color scheme", () => {
  assert.match(htmlSource, /<meta name="color-scheme" content="light" \/>/u);
  assert.doesNotMatch(htmlSource, /color-scheme" content="dark"/u);
  assert.match(cssSource, /color-scheme:\s*light;/u);
  assert.doesNotMatch(cssSource, /color-scheme:\s*dark;/u);
  assert.match(cssSource, /--portal-surface-0:\s*#f7faf8;/u);
});
