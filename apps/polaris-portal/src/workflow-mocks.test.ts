import assert from "node:assert/strict";
import test from "node:test";
import { usePortalStore } from "./portal-store.js";
import {
  cardsFromRuns,
  createMockRunsForCatalog,
  createInitialWorkflowState,
  flowForRun,
  packForRun,
  type MockDomainPack,
  updateCardFromRun,
} from "./workflow-mocks.js";

const SYNTHETIC_PACKS: MockDomainPack[] = [
  ["pack-alpha", "flow-alpha", true],
  ["pack-beta", "flow-beta", true],
  ["pack-gamma", "flow-gamma", false],
].map(([id, flowId, approvalRequired]) => ({
  id: id as string,
  title: `Example ${id}`,
  category: "Example",
  description: "Synthetic pack fixture.",
  version: "1.0.0",
  digest: `sha256:${id}`,
  capabilities: ["Synthetic capability"],
  accent: "green",
  flows: [{
    id: flowId as string,
    title: `Example ${flowId}`,
    summary: "Synthetic workflow fixture.",
    estimate: "Synthetic",
    approvalRequired: Boolean(approvalRequired),
    fields: [{ id: "input", label: "Input", type: "text", placeholder: "", required: true }],
  }],
}));

function createInitialWorkflowMockState() {
  const state = createInitialWorkflowState();
  const packs = structuredClone(SYNTHETIC_PACKS);
  const runs = createMockRunsForCatalog(packs, state.vaults);
  return {
    ...state,
    packs,
    runs: Object.fromEntries(runs.map((run) => [run.id, run])),
    cards: cardsFromRuns(runs),
    setup: {
      ...state.setup,
      domainPackId: "pack-alpha",
      enabledWorkflowKeys: ["pack-alpha:flow-alpha"],
    },
  };
}

test("initial workflow projections cover the daily, provisioning, and catalog stories", () => {
  const state = createInitialWorkflowMockState();

  assert.equal(state.setup.completed, false);
  assert.equal(state.setup.domainPackId, "pack-alpha");
  assert.deepEqual(state.setup.enabledWorkflowKeys, ["pack-alpha:flow-alpha"]);
  assert.equal(state.packs.length, 3);
  assert.equal(state.vaults.some((vault) => vault.kind === "existing"), true);
  assert.equal(state.vaults.some((vault) => vault.kind === "disposable"), true);
  assert.deepEqual(
    new Set(Object.values(state.runs).map((run) => run.status)),
    new Set(["waiting", "running", "succeeded"]),
  );
});

test("production workflow state leaves the Domain Pack catalog to Polaris", () => {
  const state = createInitialWorkflowState();

  assert.deepEqual(state.packs, []);
  assert.deepEqual(state.runs, {});
  assert.deepEqual(state.cards, []);
  assert.equal(state.setup.domainPackId, null);
  assert.deepEqual(state.setup.enabledWorkflowKeys, []);
  assert.equal(state.cards.length, Object.keys(state.runs).length);
});

test("mock runs bind to the catalog returned by Polaris", () => {
  const state = createInitialWorkflowState();
  const catalog = createInitialWorkflowMockState().packs.slice(1, 2);
  const runs = createMockRunsForCatalog(catalog, state.vaults);

  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.packId, catalog[0]?.id);
  assert.equal(runs[0]?.flowId, catalog[0]?.flows[0]?.id);
});

test("pack, flow, and work-card projections stay linked to a run", () => {
  const state = createInitialWorkflowMockState();
  const run = state.runs["mock-run-1"];
  const pack = packForRun(state.packs, run);
  const flow = flowForRun(state.packs, run);

  assert.equal(pack?.id, "pack-alpha");
  assert.equal(flow?.id, "flow-alpha");

  const updated = updateCardFromRun(state.cards, {
    ...run,
    status: "succeeded",
    progress: 100,
    updatedAt: "2026-08-11T09:30:00.000Z",
  });
  const card = updated.find((item) => item.runId === run.id);
  assert.equal(card?.status, "succeeded");
  assert.equal(card?.updatedAt, "2026-08-11T09:30:00.000Z");
});

test("Zustand mock run supports cancel and retry without losing the old card", async () => {
  usePortalStore.setState(createInitialWorkflowMockState());
  try {
    const created = await usePortalStore.getState().startWorkflowRun({
      packId: "pack-alpha",
      flowId: "flow-alpha",
      vaultId: "vault-disposable",
      values: { question: "synthetic question", audience: "synthetic audience" },
    });
    assert.equal(created.status, "queued");

    await usePortalStore.getState().cancelWorkflowRun(created.id);
    assert.equal(usePortalStore.getState().runs[created.id]?.status, "cancelled");

    const retried = await usePortalStore.getState().retryWorkflowRun(created.id);
    if (!retried) throw new Error("expected cancelled run to be retryable");
    assert.notEqual(retried.id, created.id);
    assert.equal(usePortalStore.getState().runs[retried.id]?.status, "queued");
    assert.equal(usePortalStore.getState().cards.find((card) => card.runId === created.id)?.status, "cancelled");

    await usePortalStore.getState().cancelWorkflowRun(retried.id);
  } finally {
    usePortalStore.setState(createInitialWorkflowMockState());
  }
});
