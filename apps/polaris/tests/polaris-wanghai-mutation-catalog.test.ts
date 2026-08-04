import assert from "node:assert/strict";
import test from "node:test";
import {
  findWanghaiMutationAction,
  listWanghaiMutationActions,
  matchWanghaiMutationAction,
} from "../scripts/portal/wanghai-mutation-catalog.js";

test("the Wanghai action catalog covers every integrated mutation family", () => {
  const actions = listWanghaiMutationActions();
  assert.deepEqual(
    actions.map((action) => action.id),
    [
      "workspace.create",
      "workflow.create",
      "workflow.delete",
      "workflow.paseo.update",
      "order.update",
      "order.submodule.update",
      "manual-review.update",
      "manual-review.export",
      "outreach.execute",
      "product.create",
      "product.update",
      "product.asset.upload",
      "product.delete",
      "product.asset.delete",
      "seo.site.create",
      "seo.site.update",
      "seo.metrics.snapshot",
    ],
  );
  assert.equal(new Set(actions.map((action) => action.id)).size, actions.length);
  assert.equal(findWanghaiMutationAction("outreach.execute")?.minimumRole, "admin");
  assert.equal(findWanghaiMutationAction("outreach.execute")?.externalSideEffect, true);
  assert.equal(findWanghaiMutationAction("product.asset.upload")?.body, "multipart");
});

test("catalog matching returns a stable action and only structural route parameters", () => {
  const workflow = matchWanghaiMutationAction({
    method: "POST",
    pathname: "/api/workspaces/acme/workflows",
  });
  assert.equal(workflow?.action.id, "workflow.create");
  assert.equal(workflow?.workspaceId, "acme");
  assert.deepEqual(workflow?.params, { workspace: "acme" });

  const upload = matchWanghaiMutationAction({
    method: "post",
    pathname: "/api/workspaces/acme/products/SKU-001",
  });
  assert.equal(upload?.action.id, "product.asset.upload");
  assert.equal(upload?.action.body, "multipart");
  assert.deepEqual(upload?.params, { workspace: "acme", sku: "SKU-001" });

  const metrics = matchWanghaiMutationAction({
    method: "POST",
    pathname: "/api/workspaces/acme/seo/sites/example/metrics",
  });
  assert.equal(metrics?.action.id, "seo.metrics.snapshot");
  assert.deepEqual(metrics?.params, {
    workspace: "acme",
    siteId: "example",
  });

  assert.equal(matchWanghaiMutationAction({
    method: "GET",
    pathname: "/api/workspaces/acme/products",
  }), null);
  assert.equal(matchWanghaiMutationAction({
    method: "POST",
    pathname: "/api/workspaces/acme/unknown",
  }), null);
});

test("catalog matching rejects encoded traversal and invalid workspace IDs", () => {
  assert.throws(
    () => matchWanghaiMutationAction({
      method: "POST",
      pathname: "/api/workspaces/%2e%2e/products",
    }),
    /unsafe segment|workspace ID is invalid/u,
  );
  assert.throws(
    () => matchWanghaiMutationAction({
      method: "POST",
      pathname: "/api/workspaces/acme%2Fother/products",
    }),
    /unsafe segment/u,
  );
  assert.throws(
    () => matchWanghaiMutationAction({
      method: "POST",
      pathname: "/api/workspaces/../products",
    }),
    /unsafe segment/u,
  );
  assert.throws(
    () => matchWanghaiMutationAction({
      method: "POST",
      pathname: "/api/workspaces/Acme/products",
    }),
    /workspace ID is invalid/u,
  );
});
