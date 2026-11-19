import assert from "node:assert/strict";
import test from "node:test";
import { canPopTo, historyFrom, normalizeHistoryPath } from "./portal-navigation.js";

test("reads the previous path from history state", () => {
  assert.equal(historyFrom(undefined), "");
  assert.equal(historyFrom({}), "");
  assert.equal(historyFrom({ from: "/work" }), "/work");
});

test("treats work desk paths as the same history target", () => {
  assert.equal(normalizeHistoryPath("/work/"), "/work");
  assert.equal(normalizeHistoryPath("/work?pack=literature"), "/work");
  assert.equal(normalizeHistoryPath("/work/runs/run-1"), "/work/runs/run-1");
});

test("pops back only when the previous entry is the fallback", () => {
  assert.equal(canPopTo({ from: "/work" }, "/work"), true);
  assert.equal(canPopTo({ from: "/work/" }, "/work"), true);
  assert.equal(canPopTo({ from: "/settings/workflows" }, "/work"), false);
  assert.equal(canPopTo({ from: "/work/runs/run-1" }, "/work"), false);
  assert.equal(canPopTo({ from: "/work/runs/run-1" }, "/work/runs/run-1"), true);
  assert.equal(canPopTo(null, "/work"), false);
});

test("mounted browser paths, backend URLs and artifacts share one app prefix", async (t) => {
  const mount = "/apps/polaris";
  const { portalHref, portalPathname } = await import("./portal-path.js");
  const { request, streamUrl } = await import("./portal-client.js");
  const { artifactPreviewUrl, workspaceFilePreviewUrl } = await import("./artifact-preview.js");
  assert.equal(portalHref("/work"), "/work");
  assert.equal(streamUrl(), "/api/workspace/vaults/live");

  const documentBefore = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: { portalBase: mount } } } });
  t.after(() => {
    if (documentBefore) Object.defineProperty(globalThis, "document", documentBefore);
    else Reflect.deleteProperty(globalThis, "document");
  });

  assert.equal(portalPathname(mount + "/"), "/");
  assert.equal(portalPathname(mount + "-other/work"), mount + "-other/work");
  assert.equal(portalPathname(mount + "/settings/workflows"), "/settings/workflows");
  assert.equal(portalHref("/work/runs/run-one"), mount + "/work/runs/run-one");
  assert.equal(portalPathname(mount + "/work/runs/run-one"), "/work/runs/run-one");
  assert.equal(portalHref("/work?pack=autoresearch"), mount + "/work?pack=autoresearch");
  assert.equal(streamUrl(), mount + "/api/workspace/vaults/live");
  assert.equal(artifactPreviewUrl("a/b", "report"), mount + "/api/workflow-runs/a%2Fb/artifacts/report");
  assert.equal(workspaceFilePreviewUrl("run1", "a/b"), mount + "/api/workflow-runs/run1/files?path=a%2Fb");

  const fetch = t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    assert.equal(init?.credentials, "same-origin");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return Response.json({ ok: true });
  });
  assert.deepEqual(await request("/workspace"), { ok: true });
  assert.equal(fetch.mock.calls[0].arguments[0], mount + "/api/workspace");
});


test("portal links preserve browser shortcuts and navigate once on primary activation", async () => {
  const { followPortalLink } = await import("./portal-navigation.js");
  for (const overrides of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
    let prevented = 0, navigated = 0;
    const click = { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...overrides,
      preventDefault: () => { prevented++; } };
    followPortalLink(click, () => { navigated++; });
    const expected = Object.keys(overrides).length ? 0 : 1;
    assert.equal(prevented, expected);
    assert.equal(navigated, expected);
  }
});
