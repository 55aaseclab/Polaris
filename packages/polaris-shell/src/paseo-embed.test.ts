import assert from "node:assert/strict";
import test from "node:test";
import { renderPaseoEmbedPage } from "./paseo-embed.js";

test("renderPaseoEmbedPage builds a full-screen iframe with a floating back button", () => {
  const html = renderPaseoEmbedPage({
    hostName: "coding-host",
    paseoUrl: "http://127.0.0.1:8082/h/srv_sample",
  });
  assert.match(html, /class="portal-shell"/);
  assert.match(html, /class="button secondary portal-shell-back"/);
  assert.match(html, /href="\/hosts"/);
  assert.match(html, /class="portal-shell-frame"/);
  assert.match(html, /src="http:\/\/127\.0\.0\.1:8082\/h\/srv_sample"/);
});
