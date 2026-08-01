import assert from "node:assert/strict";
import test from "node:test";
import { renderWanghaiEmbedPage } from "./wanghai-embed.js";

test("renderWanghaiEmbedPage builds a full-screen iframe with a floating back button", () => {
  const html = renderWanghaiEmbedPage({
    hostName: "vertical-host",
    portalUrl: "http://127.0.0.1:32102",
  });
  assert.match(html, /class="portal-shell"/);
  assert.match(html, /class="button secondary portal-shell-back"/);
  assert.match(html, /href="\/hosts"/);
  assert.match(html, /class="portal-shell-frame"/);
  assert.match(html, /src="http:\/\/127\.0\.0\.1:32102"/);
});
