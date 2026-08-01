import assert from "node:assert/strict";
import test from "node:test";
import { isShellPath, shellPath } from "./routes.js";
import { resolveProductForUser, productHasSurface } from "./product.js";
import { buildOpenCodingHref } from "./hosts.js";

test("shell paths cover auth user hosts only", () => {
  assert.equal(isShellPath("/welcome"), true);
  assert.equal(isShellPath("/auth/callback"), true);
  assert.equal(isShellPath("/settings/user"), true);
  assert.equal(isShellPath("/hosts"), true);
  assert.equal(isShellPath("/hosts/demo"), true);
  assert.equal(isShellPath("/"), true);
  assert.equal(isShellPath("/h/srv_x"), false);
  assert.equal(isShellPath("/h/srv_x/workspace/a"), false);
  assert.equal(isShellPath("/settings/general"), false);
});

test("shellPath builds stable links", () => {
  assert.equal(shellPath("settings-user"), "/settings/user");
  assert.equal(shellPath("host-detail", { hostKey: "demo" }), "/hosts/demo");
  assert.equal(buildOpenCodingHref("srv_1").href, "/h/srv_1");
});

test("product line is coding|vertical; plan free|pro does not pick the line", () => {
  const vertical = resolveProductForUser({ line: "vertical" });
  assert.equal(vertical.line, "vertical");
  assert.equal(productHasSurface(vertical, "wanghai"), true);

  const coding = resolveProductForUser({ line: "coding", plan: "pro" });
  assert.equal(coding.line, "coding");
  assert.equal(productHasSurface(coding, "wanghai"), false);

  // free/pro is feature richness only — never flips coding ↔ vertical.
  assert.equal(resolveProductForUser({ plan: "pro" }).id, "polaris-coding");
  assert.equal(resolveProductForUser({ plan: "free" }).id, "polaris-coding");

  const fromSurfaces = resolveProductForUser({ surfaces: ["paseo", "wanghai"] });
  assert.equal(fromSurfaces.id, "polaris-vertical");
});
