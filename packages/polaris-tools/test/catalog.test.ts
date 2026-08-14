import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFirstPartyPolarisTools,
  findPolarisToolManifest,
  getPolarisToolPortalDetail,
  invokeMockPolarisTool,
  listPolarisDomainPackToolPortalCatalogRows,
  listPolarisToolPortalCatalogRows,
  listPolarisToolManifests,
  listPolarisWorkflowActionCatalogEntries,
  polarisToolPortalPath,
  POLARIS_TOOL_PUBLISHER_ID,
  POLARIS_VAULT_ARTIFACT_METADATA_TOOL_ID,
  REQUIRED_POLARIS_LIVE_TOOL_GATES,
} from "../src/index.js";

test("the Polaris tool catalog is first-party and fails closed by default", () => {
  const manifests = listPolarisToolManifests();
  assert.ok(manifests.length > 0);
  assert.doesNotThrow(() => assertFirstPartyPolarisTools(manifests));
  assert.ok(manifests.every((tool) => tool.publisher.id === POLARIS_TOOL_PUBLISHER_ID));
  assert.ok(manifests.every((tool) => tool.workflow.liveEnabled === false));
  assert.ok(manifests.every((tool) => tool.surfaces.publicCatalog));
});

test("workflow action entries are derived from the tool manifests", () => {
  const action = listPolarisWorkflowActionCatalogEntries()
    .find((entry) => entry.id === POLARIS_VAULT_ARTIFACT_METADATA_TOOL_ID);
  assert.equal(action?.port, "ArtifactMetadata");
  assert.equal(action?.effect, "read");
  assert.equal(action?.adapter, "polaris.projection");
  assert.equal(action?.liveEnabled, false);
  assert.deepEqual(action?.requiredGates, REQUIRED_POLARIS_LIVE_TOOL_GATES);
});

test("the portal model uses Polaris-relative routes without a Wanghai origin", () => {
  const catalog = listPolarisToolPortalCatalogRows();
  assert.ok(catalog.length > 0);
  assert.ok(catalog.every((tool) => tool.href.startsWith("/tools/")));
  assert.ok(catalog.every((tool) => tool.scope === "common"));
  assert.ok(catalog.every((tool) => tool.scopeLabel === "Common"));
  assert.ok(catalog.every((tool) => tool.toolCalls.length > 0));
  assert.ok(catalog.every((tool) => tool.toolCalls.every((call) => !call.unresolved)));
  assert.ok(catalog.every((tool) => tool.toolCalls[0]?.mappedToolId === tool.id));
  assert.ok(catalog.every((tool) => !tool.href.includes("wanghai")));
  assert.ok(catalog.every((tool) => !("executionUrl" in tool)));
  assert.ok(catalog.every((tool) => !("credentialValue" in tool)));

  const detail = getPolarisToolPortalDetail("manual-review");
  assert.equal(detail?.href, "/tools/manual-review");
  assert.equal(detail?.actionId, "manual.review");
});

test("domain pack tool rows are derived without live execution material", () => {
  const packs = [{
    id: "SyntheticPack",
    title: "Synthetic Pack",
    version: "1.0.0",
    digest: "sha256-synthetic",
    flows: [{
      id: "ReviewEvidence",
      title: "Review Evidence",
      summary: "Review a bounded synthetic brief.",
      approvalRequired: true,
      toolCalls: [{
        id: "review",
        port: "ReviewPlan",
        version: "1.0.0",
        effect: "human",
        builtin: "manual.review",
        unresolved: false,
      }],
      fields: [{
        id: "brief",
        label: "Evidence brief",
        type: "textarea",
        placeholder: "Synthetic input",
        required: true,
      }],
    }],
  }];

  const catalog = listPolarisDomainPackToolPortalCatalogRows(packs);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]?.id, "domain-pack:SyntheticPack:ReviewEvidence");
  assert.equal(catalog[0]?.scope, "domain-pack");
  assert.equal(catalog[0]?.scopeLabel, "Synthetic Pack");
  assert.equal(catalog[0]?.domainPack?.id, "SyntheticPack");
  assert.equal(catalog[0]?.domainPack?.version, "1.0.0");
  assert.deepEqual(catalog[0]?.fields, [{
    id: "brief",
    label: "Evidence brief",
    type: "textarea",
    placeholder: "Synthetic input",
    required: true,
  }]);
  assert.equal(catalog[0]?.href, "/tools/packs/SyntheticPack/synthetic-pack-review-evidence");
  assert.equal(catalog[0]?.liveState, "mock-only");
  assert.equal(catalog[0]?.toolCalls[0]?.port, "ReviewPlan");
  assert.equal(catalog[0]?.toolCalls[0]?.builtin, "manual.review");
  assert.equal(catalog[0]?.toolCalls[0]?.mappedToolId, "manual.review");
  assert.ok(catalog.every((tool) => !("executionUrl" in tool)));
  assert.ok(catalog.every((tool) => !("credentialValue" in tool)));
});

test("tool portal paths reject absolute URLs", () => {
  assert.equal(polarisToolPortalPath("manual-review"), "/tools/manual-review");
  assert.throws(
    () => polarisToolPortalPath("https://example.invalid/tool"),
    /relative/u,
  );
});

test("mock tool invocation produces synthetic receipts only", () => {
  const result = invokeMockPolarisTool({
    toolId: POLARIS_VAULT_ARTIFACT_METADATA_TOOL_ID,
    requestId: "request-synthetic",
    input: { artifactScope: "latest" },
  });
  assert.equal(result.status, "mocked");
  assert.equal(result.receipt.owner, "polaris");
  assert.deepEqual(result.output.latestTitles, [
    "Synthetic artifact",
    "Synthetic receipt",
  ]);
});

test("tool lookup accepts either id or public slug", () => {
  assert.equal(findPolarisToolManifest("manual-review")?.id, "manual.review");
  assert.equal(
    findPolarisToolManifest(POLARIS_VAULT_ARTIFACT_METADATA_TOOL_ID)?.slug,
    "vault-artifact-metadata-read",
  );
});
