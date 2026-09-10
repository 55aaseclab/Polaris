import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compileHostLiteratureInput,
  executeHostLiteratureReview,
  filterHostLiteratureEnvironment,
} from "../scripts/portal/literature-review-host.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const FAKE_CODEX = path.join(
  REPO_ROOT,
  "apps",
  "polaris",
  "tests",
  "fixtures",
  "polaris-literature-fake-codex.py",
);

type HostRun = Parameters<typeof compileHostLiteratureInput>[0]["run"];

function runFixture(input: Record<string, string>): HostRun {
  return {
    id: "run-host-literature-test",
    tenantId: "tenant-host-literature-test",
    packId: "SysSecResearch",
    packVersion: "0.1.3",
    packDigest: "sha256:synthetic-pack",
    flowId: "LiteratureReview",
    input,
  };
}

function withEnvironment(root: string): () => void {
  const keys = [
    "POLARIS_DATA_ROOT",
    "POLARIS_LITERATURE_WORKSPACES_ROOT",
    "POLARIS_LITERATURE_CACHE_ROOT",
    "POLARIS_LITERATURE_CODEX_BIN",
    "POLARIS_LITERATURE_HOST_NETWORK",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.POLARIS_DATA_ROOT = path.join(root, "data");
  process.env.POLARIS_LITERATURE_WORKSPACES_ROOT = path.join(root, "workspaces");
  process.env.POLARIS_LITERATURE_CACHE_ROOT = path.join(root, "cache");
  process.env.POLARIS_LITERATURE_CODEX_BIN = FAKE_CODEX;
  process.env.POLARIS_LITERATURE_HOST_NETWORK = "deny";
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("host compiler maps a SysSec literature brief to the canonical collection contract", () => {
  const request = { importMetaUrl: import.meta.url, run: runFixture({ brief: "bounded workflow evidence" }), signal: new AbortController().signal };
  const input = compileHostLiteratureInput(request);
  assert.equal(input.schema_version, "clue.data-collection.input.v2");
  assert.equal(input.collection_kind, "literature");
  assert.equal(input.question, "bounded workflow evidence");
  assert.equal((input.source_tasks as Array<Record<string, unknown>>).length, 2);
  assert.deepEqual(
    (input.source_tasks as Array<Record<string, unknown>>).map((task) => task.source_type),
    ["crossref-search", "semantic-scholar-search"],
  );
  assert.deepEqual(input.pipeline, { review_mode: "auto-pass", skip_augmentation: true });
});

test("host child environment forwards reviewed runtime settings only", () => {
  const filtered = filterHostLiteratureEnvironment({
    PATH: "/usr/bin",
    HOME: "/tmp/polaris-home",
    POLARIS_LITERATURE_CODEX_BIN: "/usr/local/bin/codex",
    POLARIS_LITERATURE_CACHE_ROOT: "/tmp/cache",
    OPENAI_API_KEY: "synthetic-provider-key",
    POLARIS_AUTHING_APP_SECRET: "must-not-be-forwarded",
    WANGHAI_GATEWAY_MASTER_SECRET: "must-not-be-forwarded",
    RANDOM_APPLICATION_SECRET: "must-not-be-forwarded",
  });
  assert.deepEqual(filtered, {
    PATH: "/usr/bin",
    HOME: "/tmp/polaris-home",
    POLARIS_LITERATURE_CODEX_BIN: "/usr/local/bin/codex",
    POLARIS_LITERATURE_CACHE_ROOT: "/tmp/cache",
    OPENAI_API_KEY: "synthetic-provider-key",
  });
});

test("host adapter runs the migrated lifecycle and projects real report artifacts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-host-literature-adapter-"));
  const restore = withEnvironment(root);
  try {
    const collectionInput = {
      schema_version: "clue.data-collection.input.v2",
      collection_id: "host-adapter-collection",
      collection_kind: "literature",
      question: "Which bounded behavior is supported by the synthetic corpus?",
      decision_context: "Exercise the Polaris host adapter.",
      audience: "research engineering",
      scope: { time_range: "2024..2026", include: ["bounded behavior"] },
      evidence_policy: {
        required_fields: ["source_url", "quote", "observed_at", "content_hash"],
      },
      source_tasks: [
        {
          task_id: "synthetic-source",
          source_type: "crossref-search",
          config: { query: "bounded behavior" },
        },
      ],
      payload: {
        literature_scope: { enabled: true },
        pdf_links: { enabled: true },
      },
      pipeline: { review_mode: "auto-pass", skip_augmentation: true },
    };
    const collectionOutput = {
      schema_version: "clue.data-collection.output.v2",
      collection_id: "host-adapter-collection",
      collection_kind: "literature",
      status: "final",
      records: [
        {
          record_id: "synthetic-paper",
          record_kind: "literature-candidate",
          source_url: "https://source.example/synthetic-paper",
          observed_at: "2026-01-01T00:00:00Z",
          content_hash: "sha256:synthetic-paper",
          evidence: [{ quote: "The synthetic corpus supports bounded behavior.", locator: "abstract" }],
          payload: {
            title: "Synthetic bounded behavior study",
            author: [{ given: "S", family: "Author" }],
            year: 2025,
          },
        },
      ],
      rejected_records: [],
      run_artifacts: [],
      information_gaps: [],
      pipeline: { review_mode: "auto-pass", skip_augmentation: true },
    };
    const run = runFixture({
      brief: collectionInput.question,
      collectionInput: JSON.stringify(collectionInput),
      collectionOutput: JSON.stringify(collectionOutput),
      skipAugmentation: "true",
      reportMode: "fixed",
      literatureMethod: "iterate",
      reviewMode: "auto-pass",
    });
    const progress: string[] = [];
    const result = await executeHostLiteratureReview({
      importMetaUrl: import.meta.url,
      run,
      signal: new AbortController().signal,
      onProgress: (update) => progress.push(update.stage),
    });
    assert.equal(result.status, "succeeded");
    assert.ok(result.artifacts.some((artifact) => artifact.name === "report.md"));
    assert.ok(result.artifacts.some((artifact) => artifact.name === "report.pdf"));
    const reportManifest = result.artifacts.find((artifact) => artifact.name === "report.json");
    assert.ok(reportManifest);
    assert.equal(reportManifest.redacted, false);
    const reportManifestContent = JSON.parse(reportManifest.content) as {
      status: string;
      report_path?: string;
    };
    assert.equal(reportManifestContent.status, "published");
    assert.equal(reportManifestContent.report_path, "report.md");
    assert.doesNotMatch(reportManifest.content, /Redacted host artifact/u);
    assert.doesNotMatch(reportManifest.content, /literature-host-workspaces/u);
    const markdown = result.artifacts.find((artifact) => artifact.name === "report.md")?.content || "";
    assert.ok(markdown.length > 100);
    assert.doesNotMatch(markdown, /Synthetic artifact from/u);
    assert.equal(result.receipts[0]?.port, "LiteratureReviewHost");
    assert.ok(progress.includes("admission"));
    assert.ok(progress.includes("complete"));
  } finally {
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
