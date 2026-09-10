import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runPipeline } from "polaris-workflow";

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../..",
);
const DEFINITION = path.join(
  REPO_ROOT,
  "packs",
  "autoresearch",
  "main.ord",
);
const WORKFLOW_ROOT = path.join(
  REPO_ROOT,
  "packs",
  "autoresearch",
);
const EXAMPLE_INPUT = path.join(
  WORKFLOW_ROOT,
  "examples",
  "collection-input.json",
);
const COMMON_TOOLS_ROOT = path.join(REPO_ROOT, "tools");
const TOOL_INVENTORY = path.join(COMMON_TOOLS_ROOT, "tool-inventory.json");
const WORKFLOW_METADATA = path.join(WORKFLOW_ROOT, "workflow.json");
const FAKE_CODEX = path.join(
  REPO_ROOT,
  "apps",
  "polaris",
  "tests",
  "fixtures",
  "polaris-literature-fake-codex.py",
);

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("WANGHAI_")) delete environment[key];
  }
  return environment;
}

test("the literature workflow binds every node to one shared root tool", () => {
  const source = fs.readFileSync(DEFINITION, "utf8");
  const result = runPipeline(source);
  assert.equal(result.ok, true, result.issues.map((issue) => issue.message).join("; "));
  assert.equal(result.ast?.languageVersion, "0.4-trial");
  const trial = result.ast?.trials?.find(
    (candidate) => candidate.name === "LiteratureReviewExecution",
  );
  assert.ok(trial);
  const inventory = JSON.parse(fs.readFileSync(TOOL_INVENTORY, "utf8")) as {
    tools: Array<{ id: string }>;
  };
  const metadata = JSON.parse(fs.readFileSync(WORKFLOW_METADATA, "utf8")) as {
    port_bindings: Record<string, string>;
  };
  const toolIds = new Set(inventory.tools.map((tool) => tool.id));
  const nodePorts = trial.nodes.map((node) => {
    assert.ok(node.call, `trial node ${node.id} must call a bound port`);
    return node.call.name;
  });
  assert.deepEqual(
    Object.keys(metadata.port_bindings).sort(),
    [...nodePorts].sort(),
  );
  for (const node of trial.nodes) {
    assert.ok(node.call);
    assert.ok(
      toolIds.has(metadata.port_bindings[node.call.name] ?? ""),
      `${node.call.name} must bind to a shared tool`,
    );
  }
  assert.equal(trial.nodes.length, 18);
  assert.equal(trial.edges.length, 22);
});

test("literature-review remains a workflow and common tools have one root", () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "tools")), true);
  assert.equal(fs.existsSync(WORKFLOW_ROOT), true);
  assert.equal(fs.existsSync(DEFINITION), true);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "apps", "polaris", "tools")), false);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "apps", "polaris", "workflows")), false);
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, "apps", "polaris", "domain-packs", "literature-review")),
    false,
  );
});

test("the public Polaris CLI dispatches the literature-review domain pack", () => {
  const environment = cleanEnvironment();
  delete environment.POLARIS_DATA_ROOT;
  delete environment.POLARIS_NETFS_LOCAL_EXPORT_ROOT;
  const result = spawnSync(
    path.join(REPO_ROOT, "apps", "polaris", "node_modules", ".bin", "tsx"),
    ["scripts/polaris.ts", "literature-review", "plan"],
    {
      cwd: path.join(REPO_ROOT, "apps", "polaris"),
      env: environment,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as {
    status: string;
    workflow_definition: { language_version: string; trial: { nodes: unknown[] } };
  };
  assert.equal(payload.status, "valid");
  assert.equal(payload.workflow_definition.language_version, "0.4-trial");
  assert.equal(payload.workflow_definition.trial.nodes.length, 18);
});

test("the literature-review visualize subcommand renders PNG and PDF from the pinned trial", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-literature-visualize-"));
  const cli = path.join(REPO_ROOT, "apps", "polaris", "node_modules", ".bin", "tsx");
  try {
    for (const format of ["png", "pdf"] as const) {
      const output = path.join(root, `literature-review.${format}`);
      const options = format === "png"
        ? ["--output", output]
        : ["--format=pdf", `--output=${output}`];
      const result = spawnSync(
        cli,
        [
          "scripts/polaris.ts",
          "literature-review",
          "visualize",
          ...options,
        ],
        { cwd: path.join(REPO_ROOT, "apps", "polaris"), encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout) as {
        status: string;
        workflow: string;
        format: string;
        output: string;
        nodes: number;
        edges: number;
      };
      assert.deepEqual(
        {
          status: payload.status,
          workflow: payload.workflow,
          format: payload.format,
          output: payload.output,
          nodes: payload.nodes,
          edges: payload.edges,
        },
        {
          status: "rendered",
          workflow: "LiteratureReviewExecution",
          format,
          output,
          nodes: 18,
          edges: 22,
        },
      );
      const bytes = fs.readFileSync(output);
      if (format === "png") {
        assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      } else {
        assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-");
      }
      assert.ok(bytes.length > 100);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the literature-review visualizer fails closed when Graphviz is unavailable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-literature-visualize-missing-"));
  const output = path.join(root, "missing.png");
  const cli = path.join(REPO_ROOT, "apps", "polaris", "node_modules", ".bin", "tsx");
  const environment = cleanEnvironment();
  environment.POLARIS_LITERATURE_GRAPHVIZ_BIN = path.join(root, "not-a-renderer");
  try {
    const result = spawnSync(
      cli,
      ["scripts/polaris.ts", "literature-review", "visualize", "--output", output],
      { cwd: path.join(REPO_ROOT, "apps", "polaris"), env: environment, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Graphviz renderer .* is not available/u);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the Polaris literature workflow dry-run works without Wanghai variables or a Wanghai checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-literature-cli-"));
  const workspaceRoot = path.join(root, "workspaces");
  fs.mkdirSync(path.join(workspaceRoot, "research-demo"), { recursive: true });
  const environment = cleanEnvironment();
  environment.POLARIS_LITERATURE_WORKSPACES_ROOT = workspaceRoot;
  environment.POLARIS_LITERATURE_CACHE_ROOT = path.join(root, "cache");
  const result = spawnSync(
    path.join(WORKFLOW_ROOT, "polaris-literature-review"),
    [
      "run",
      "--input",
      EXAMPLE_INPUT,
      "--workspace",
      "research-demo",
      "--run-id",
      "synthetic-run",
      "--dry-run",
    ],
    {
      cwd: REPO_ROOT,
      env: environment,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as {
    status: string;
    workflow: string;
    stages: Array<{ stage: string; status: string }>;
    definition: { path: string };
  };
  assert.equal(output.status, "planned");
  assert.equal(output.workflow, "LiteratureReviewExecution");
  assert.deepEqual(
    output.stages.map((stage) => [stage.stage, stage.status]),
    [
      ["collection", "planned"],
      ["analysis", "planned"],
      ["report-writing", "planned"],
    ],
  );
  assert.equal(output.definition.path, DEFINITION);
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, "research-demo", "literature-review", "synthetic-run", "run.json")),
    true,
  );
});

test("the Polaris literature CLI loads workspace settings from --env-file before validation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-literature-env-file-"));
  const workspaceRoot = path.join(root, "workspaces");
  const cacheRoot = path.join(root, "cache");
  fs.mkdirSync(path.join(workspaceRoot, "research-demo"), { recursive: true });
  fs.mkdirSync(cacheRoot, { recursive: true });
  const envFile = path.join(root, "literature.env");
  fs.writeFileSync(
    envFile,
    [
      `POLARIS_LITERATURE_WORKSPACES_ROOT=${workspaceRoot}`,
      `POLARIS_LITERATURE_CACHE_ROOT=${cacheRoot}`,
      "POLARIS_LITERATURE_RUNTIME_MODE=local",
      "",
    ].join("\n"),
  );
  const environment = cleanEnvironment();
  delete environment.POLARIS_LITERATURE_WORKSPACES_ROOT;
  delete environment.POLARIS_LITERATURE_CACHE_ROOT;
  delete environment.POLARIS_LITERATURE_RUNTIME_MODE;
  const result = spawnSync(
    path.join(WORKFLOW_ROOT, "polaris-literature-review"),
    [
      "run",
      "--input",
      EXAMPLE_INPUT,
      "--workspace",
      "research-demo",
      "--run-id",
      "env-file-run",
      "--env-file",
      envFile,
      "--dry-run",
    ],
    { cwd: REPO_ROOT, env: environment, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal((JSON.parse(result.stdout) as { status: string }).status, "planned");
});

test("the Polaris Codex binary override keeps the workflow wrapper in the call path", () => {
  const environment = cleanEnvironment();
  environment.POLARIS_LITERATURE_CODEX_BIN = "/synthetic/codex";
  delete environment.POLARIS_LITERATURE_CODEX_CLI;
  delete environment.CODEX_CLI;
  const loader = path.join(WORKFLOW_ROOT, "load-env.sh");
  const result = spawnSync(
    "bash",
    ["-c", `source "$1"; printf '%s\\n' "$CODEX_BIN"; printf '%s\\n' "$CODEX_CLI"`, "polaris-env-test", loader],
    { cwd: REPO_ROOT, env: environment, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "/synthetic/codex",
    path.join(COMMON_TOOLS_ROOT, "codex", "clue-codex-cli"),
  ]);
});

test("a pending collection review stops before analysis and preserves a resumable manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-literature-collection-review-"));
  const workspaceRoot = path.join(root, "workspaces");
  fs.mkdirSync(path.join(workspaceRoot, "research-demo"), { recursive: true });
  const inputPath = path.join(root, "input.json");
  const outputPath = path.join(root, "pending-output.json");
  const input = JSON.parse(fs.readFileSync(EXAMPLE_INPUT, "utf8")) as Record<string, unknown>;
  input.collection_id = "synthetic-pending";
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2));
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        schema_version: "clue.data-collection.output.v2",
        collection_id: "synthetic-pending",
        collection_kind: "literature",
        status: "pending_manual_review",
        records: [],
        rejected_records: [],
        run_artifacts: [],
        information_gaps: ["Synthetic review is pending."],
      },
      null,
      2,
    ),
  );
  const environment = cleanEnvironment();
  environment.POLARIS_LITERATURE_WORKSPACES_ROOT = workspaceRoot;
  environment.POLARIS_LITERATURE_CACHE_ROOT = path.join(root, "cache");
  fs.mkdirSync(environment.POLARIS_LITERATURE_CACHE_ROOT, { recursive: true });
  const result = spawnSync(
    path.join(WORKFLOW_ROOT, "polaris-literature-review"),
    [
      "run",
      "--input",
      inputPath,
      "--collection-output",
      outputPath,
      "--workspace",
      "research-demo",
      "--run-id",
      "pending-collection",
      "--network",
      "deny",
    ],
    { cwd: REPO_ROOT, env: environment, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(result.stdout) as {
    status: string;
    stages: Array<{ stage: string; status: string }>;
    paths: Record<string, string>;
  };
  assert.equal(manifest.status, "pending_manual_review");
  assert.deepEqual(
    manifest.stages.map((stage) => [stage.stage, stage.status]),
    [["collection", "resumed"]],
  );
  assert.equal(fs.existsSync(manifest.paths.analysis_output!), false);
});

test("Polaris saves collection review decisions and continues into analysis", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-literature-collection-resume-"));
  const workspaceRoot = path.join(root, "workspaces");
  const workspace = path.join(workspaceRoot, "research-demo");
  const cacheRoot = path.join(root, "cache");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(cacheRoot, { recursive: true });

  const inputPath = path.join(root, "input.json");
  const collectionOutputPath = path.join(root, "collection-output.json");
  const input = JSON.parse(fs.readFileSync(EXAMPLE_INPUT, "utf8")) as Record<string, unknown>;
  input.collection_id = "synthetic-collection-resume";
  input.question = "Which synthetic result survives collection review?";
  input.decision_context = "Exercise Polaris collection review continuation.";
  input.pipeline = { review_mode: "manual-review", skip_augmentation: true };
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2));

  const paper = {
    record_id: "paper-collection-review",
    record_kind: "literature-candidate",
    source_url: "https://source.example/collection-review",
    observed_at: "2026-01-04T00:00:00Z",
    content_hash: "sha256:collection-review",
    evidence: [{ quote: "The collection review fixture is admissible.", locator: "abstract" }],
    payload: {
      title: "Synthetic collection review paper",
      author: [{ given: "C", family: "Researcher" }],
      year: 2026,
    },
  };
  fs.writeFileSync(
    collectionOutputPath,
    JSON.stringify(
      {
        schema_version: "clue.data-collection.output.v2",
        collection_id: "synthetic-collection-resume",
        collection_kind: "literature",
        status: "pending_manual_review",
        records: [paper],
        rejected_records: [],
        run_artifacts: [],
        information_gaps: [],
        pipeline: { review_mode: "manual-review" },
      },
      null,
      2,
    ),
  );

  const collectionBase = path.join(
    workspace,
    "data-collections",
    "synthetic-collection-resume",
  );
  fs.mkdirSync(path.join(collectionBase, "outputs"), { recursive: true });
  fs.mkdirSync(path.join(collectionBase, "work"), { recursive: true });
  fs.writeFileSync(
    path.join(collectionBase, "outputs", "manual-review-list.json"),
    JSON.stringify(
      {
        schema_version: "clue.data-collection.review-list.v1",
        collection_id: "synthetic-collection-resume",
        collection_kind: "literature",
        review_records: [paper],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(collectionBase, "outputs", "non-review-results.json"),
    JSON.stringify(
      {
        schema_version: "clue.data-collection.non-review.v1",
        collection_id: "synthetic-collection-resume",
        collection_kind: "literature",
        qualified_without_manual_review: [],
        rejected_records: [],
      },
      null,
      2,
    ),
  );

  const environment = cleanEnvironment();
  environment.POLARIS_LITERATURE_WORKSPACES_ROOT = workspaceRoot;
  environment.POLARIS_LITERATURE_CACHE_ROOT = cacheRoot;
  environment.POLARIS_LITERATURE_RUNTIME_MODE = "local";
  environment.POLARIS_LITERATURE_CODEX_BIN = FAKE_CODEX;
  const initial = spawnSync(
    path.join(WORKFLOW_ROOT, "polaris-literature-review"),
    [
      "run",
      "--input",
      inputPath,
      "--collection-output",
      collectionOutputPath,
      "--workspace",
      "research-demo",
      "--run-id",
      "collection-resume",
      "--analysis-id",
      "collection-analysis",
      "--report-id",
      "collection-report",
      "--network",
      "deny",
      "--review-mode",
      "manual-review",
      "--literature-method",
      "iterate",
      "--report-mode",
      "fixed",
      "--template",
      "literature-report",
    ],
    { cwd: REPO_ROOT, env: environment, encoding: "utf8" },
  );
  assert.equal(initial.status, 0, initial.stderr);
  const pending = JSON.parse(initial.stdout) as {
    status: string;
    paths: Record<string, string>;
  };
  assert.equal(pending.status, "pending_manual_review");
  const saved = spawnSync(
    path.join(WORKFLOW_ROOT, "polaris-literature-review"),
    [
      "collection-review",
      "save",
      "--run-manifest",
      pending.paths.run_manifest,
      "--record-id",
      "paper-collection-review",
      "--status",
      "approved",
      "--note",
      "Synthetic Polaris approval.",
    ],
    { cwd: REPO_ROOT, env: environment, encoding: "utf8" },
  );
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /"status": "approved"/u);

  const continued = spawnSync(
    path.join(WORKFLOW_ROOT, "polaris-literature-review"),
    ["complete-collection-review", "--run-manifest", pending.paths.run_manifest],
    { cwd: REPO_ROOT, env: environment, encoding: "utf8" },
  );
  assert.equal(continued.status, 0, continued.stderr);
  const resumed = JSON.parse(continued.stdout) as {
    status: string;
    pending_stage?: string;
    collection_review: { status: string };
    paths: Record<string, string>;
  };
  assert.equal(resumed.status, "pending_manual_review");
  assert.equal(resumed.pending_stage, "analysis");
  assert.equal(resumed.collection_review.status, "completed");
  const finalCollection = JSON.parse(
    fs.readFileSync(resumed.paths.collection_output!, "utf8"),
  ) as { status: string; records: Array<{ record_id: string; manual_review?: { status: string } }> };
  assert.equal(finalCollection.status, "final");
  assert.equal(finalCollection.records[0]?.record_id, "paper-collection-review");
  assert.equal(finalCollection.records[0]?.manual_review?.status, "approved");
  assert.equal(
    JSON.parse(fs.readFileSync(resumed.paths.collection_review_result!, "utf8")).schema_version,
    "clue.data-collection.review-output.v1",
  );
});

test("the Polaris runner rejects a collection handoff from another collection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-literature-collection-binding-"));
  const workspaceRoot = path.join(root, "workspaces");
  fs.mkdirSync(path.join(workspaceRoot, "research-demo"), { recursive: true });
  const inputPath = path.join(root, "input.json");
  const outputPath = path.join(root, "wrong-output.json");
  const input = JSON.parse(fs.readFileSync(EXAMPLE_INPUT, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2));
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        schema_version: "clue.data-collection.output.v2",
        collection_id: "different-collection",
        collection_kind: "literature",
        status: "final",
        records: [],
        rejected_records: [],
        run_artifacts: [],
        information_gaps: [],
      },
      null,
      2,
    ),
  );
  const environment = cleanEnvironment();
  environment.POLARIS_LITERATURE_WORKSPACES_ROOT = workspaceRoot;
  environment.POLARIS_LITERATURE_CACHE_ROOT = path.join(root, "cache");
  fs.mkdirSync(environment.POLARIS_LITERATURE_CACHE_ROOT, { recursive: true });
  const result = spawnSync(
    path.join(WORKFLOW_ROOT, "polaris-literature-review"),
    [
      "run",
      "--input",
      inputPath,
      "--collection-output",
      outputPath,
      "--workspace",
      "research-demo",
      "--run-id",
      "binding-check",
    ],
    { cwd: REPO_ROOT, env: environment, encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /collection_id does not match/u);
  const failedManifest = JSON.parse(
    fs.readFileSync(
      path.join(
        workspaceRoot,
        "research-demo",
        "literature-review",
        "binding-check",
        "run.json",
      ),
      "utf8",
    ),
  ) as { status: string; error?: { message?: string } };
  assert.equal(failedManifest.status, "failed");
  assert.match(failedManifest.error?.message ?? "", /collection_id does not match/u);
});

test("the migrated workflow remains fail-closed in integrated mode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-literature-integrated-"));
  const workspaceRoot = path.join(root, "workspaces");
  fs.mkdirSync(path.join(workspaceRoot, "research-demo"), { recursive: true });
  const environment = cleanEnvironment();
  environment.POLARIS_LITERATURE_WORKSPACES_ROOT = workspaceRoot;
  environment.POLARIS_LITERATURE_CACHE_ROOT = path.join(root, "cache");
  environment.POLARIS_LITERATURE_RUNTIME_MODE = "polaris";
  const result = spawnSync(
    path.join(WORKFLOW_ROOT, "polaris-literature-review"),
    [
      "run",
      "--input",
      EXAMPLE_INPUT,
      "--workspace",
      "research-demo",
      "--run-id",
      "integrated-run",
      "--network",
      "allow",
    ],
    { cwd: REPO_ROOT, env: environment, encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Polaris durable job/u);
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, "research-demo", "literature-review", "integrated-run")),
    false,
  );
});

test("every side-effecting migrated tool entrypoint is fail-closed in integrated mode", () => {
  const environment = cleanEnvironment();
  environment.POLARIS_LITERATURE_RUNTIME_MODE = "polaris";
  const tools = [
    ["data-collection", ["run"]],
    ["semantic-scholar", ["search"]],
    ["crossref", ["search"]],
    ["deepsec", ["search"]],
    ["intelligence-analysis", ["run"]],
    ["report-writing", ["run"]],
    ["codex", ["exec"]],
    ["browser", ["run"]],
    ["collection-review", ["bootstrap"]],
    ["analysis-review", ["bootstrap"]],
    ["web-search", ["server-start"]],
    ["image-review", ["review"]],
    ["video-review", ["extract-audio"]],
    ["social-media", ["batch"]],
  ] as const;
  const executableNames: Record<string, string> = {
    "data-collection": "clue-data-collection",
    "semantic-scholar": "clue-semantic-scholar-cli",
    crossref: "clue-crossref-cli",
    deepsec: "clue-deepsec-cli",
    "intelligence-analysis": "clue-intelligence-analysis",
    "report-writing": "clue-report-writing",
    codex: "clue-codex-cli",
    browser: "clue-browser",
    "collection-review": "clue-collection-review",
    "analysis-review": "clue-analysis-review",
    "web-search": "clue-web-search-cli",
    "image-review": "clue-image-review",
    "video-review": "clue-video-review",
    "social-media": "clue-justoneapi-cli",
  };
  for (const [tool, args] of tools) {
    const executableName = executableNames[tool];
    assert.ok(executableName, tool);
    const entrypoint = path.join(
      COMMON_TOOLS_ROOT,
      tool,
      executableName,
    );
    const result = spawnSync(entrypoint, args, {
      cwd: REPO_ROOT,
      env: environment,
      encoding: "utf8",
    });
    assert.equal(result.status, 2, tool);
    assert.match(`${result.stdout}\n${result.stderr}`, /durable job/u, tool);
  }
});

test("the Polaris literature workflow dependency installer is fail-closed in integrated mode", () => {
  const environment = cleanEnvironment();
  environment.POLARIS_LITERATURE_RUNTIME_MODE = "polaris";
  const result = spawnSync(
    path.join(WORKFLOW_ROOT, "install-dependencies.sh"),
    ["--skip-browser", "--skip-external-backends"],
    { cwd: REPO_ROOT, env: environment, encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}\n${result.stderr}`, /durable job/u);
});

test("the shared data-collection installer is fail-closed in integrated mode", () => {
  const environment = cleanEnvironment();
  environment.POLARIS_LITERATURE_RUNTIME_MODE = "polaris";
  const result = spawnSync(
    path.join(COMMON_TOOLS_ROOT, "data-collection", "install-dependencies.sh"),
    ["--skip-browser", "--skip-external-backends"],
    { cwd: REPO_ROOT, env: environment, encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}\n${result.stderr}`, /durable job/u);
});

test("Polaris runs the migrated collection-to-analysis-to-report lifecycle end to end", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-literature-e2e-"));
  const workspaceRoot = path.join(root, "workspaces");
  const workspace = path.join(workspaceRoot, "research-demo");
  const cacheRoot = path.join(root, "cache");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(cacheRoot, { recursive: true });

  const inputPath = path.join(root, "input.json");
  const collectionOutputPath = path.join(root, "collection-output.json");
  const codexLogPath = path.join(root, "codex-log.json");
  fs.writeFileSync(
    inputPath,
    JSON.stringify(
      {
        schema_version: "clue.data-collection.input.v2",
        collection_id: "synthetic-e2e",
        collection_kind: "literature",
        question: "What does the synthetic literature establish about bounded workflows?",
        decision_context: "Verify the Polaris-owned lifecycle.",
        audience: "research engineering",
        scope: { time_range: "2024..2026", include: ["workflow"] },
        evidence_policy: {
          required_fields: ["source_url", "quote", "observed_at", "content_hash"],
        },
        source_tasks: [
          {
            task_id: "synthetic-source",
            source_type: "crossref-search",
            config: { query: "bounded workflows" },
          },
        ],
        payload: {},
        pipeline: { review_mode: "auto-pass", skip_augmentation: true },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    collectionOutputPath,
    JSON.stringify(
      {
        schema_version: "clue.data-collection.output.v2",
        collection_id: "synthetic-e2e",
        collection_kind: "literature",
        status: "final",
        records: [
          {
            record_id: "paper-alpha",
            record_kind: "literature-candidate",
            source_url: "https://source.example/alpha",
            observed_at: "2026-01-01T00:00:00Z",
            content_hash: "sha256:alpha",
            evidence: [{ quote: "Alpha reports bounded workflow behavior.", locator: "abstract" }],
            payload: {
              title: "Synthetic bounded workflow study",
              author: [{ given: "A", family: "Author" }],
              year: 2025,
              "container-title": ["Synthetic Systems Venue"],
            },
          },
          {
            record_id: "paper-beta",
            record_kind: "literature-candidate",
            source_url: "https://source.example/beta",
            observed_at: "2026-01-02T00:00:00Z",
            content_hash: "sha256:beta",
            evidence: [{ quote: "Beta corroborates bounded workflow behavior.", locator: "abstract" }],
            payload: {
              title: "Synthetic corroborating workflow study",
              author: [{ given: "B", family: "Researcher" }],
              year: 2026,
              "container-title": ["Synthetic Systems Venue"],
            },
          },
        ],
        rejected_records: [],
        run_artifacts: [],
        information_gaps: [],
        pipeline: { review_mode: "auto-pass", skip_augmentation: true },
      },
      null,
      2,
    ),
  );
  const finishedExpansionDir = path.join(
    workspace,
    "data-collections",
    "synthetic-e2e",
    "work",
    "synthetic-e2e-expand",
  );
  fs.mkdirSync(finishedExpansionDir, { recursive: true });
  fs.copyFileSync(
    collectionOutputPath,
    path.join(finishedExpansionDir, "expanded-collection.json"),
  );
  fs.writeFileSync(
    path.join(finishedExpansionDir, "expand-state.json"),
    JSON.stringify({ frontier: [], round: 1 }, null, 2),
  );

  const environment = cleanEnvironment();
  environment.POLARIS_LITERATURE_WORKSPACES_ROOT = workspaceRoot;
  environment.POLARIS_LITERATURE_CACHE_ROOT = cacheRoot;
  environment.POLARIS_LITERATURE_RUNTIME_MODE = "local";
  environment.POLARIS_LITERATURE_CODEX_BIN = FAKE_CODEX;
  environment.POLARIS_TEST_CODEX_LOG = codexLogPath;
  const result = spawnSync(
    path.join(WORKFLOW_ROOT, "polaris-literature-review"),
    [
      "run",
      "--input",
      inputPath,
      "--workspace",
      "research-demo",
      "--run-id",
      "synthetic-e2e",
      "--analysis-id",
      "synthetic-analysis",
      "--report-id",
      "synthetic-report",
      "--network",
      "deny",
      "--review-mode",
      "auto-pass",
      "--literature-method",
      "iterate",
      "--report-mode",
      "reviewed",
      "--template",
      "literature-report",
      "--codex-model",
      "synthetic-model",
      "--reasoning-effort",
      "low",
    ],
    { cwd: REPO_ROOT, env: environment, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(result.stdout) as {
    status: string;
    stages: Array<{ stage: string; status: string }>;
    paths: Record<string, string>;
  };
  assert.equal(manifest.status, "succeeded");
  assert.deepEqual(
    manifest.stages.map((stage) => [stage.stage, stage.status]),
    [
      ["collection", "final"],
      ["analysis", "final"],
      ["report-writing", "succeeded"],
    ],
  );
  const collectionStage = manifest.stages[0] as {
    pipeline?: { phases?: Array<{ status?: string }> };
  };
  assert.deepEqual(
    collectionStage.pipeline?.phases?.map((phase) => phase.status),
    ["resumed", "resumed", "skipped", "auto_passed"],
  );

  const analysisOutput = JSON.parse(
    fs.readFileSync(manifest.paths.analysis_output, "utf8"),
  ) as { schema_version: string; status: string; judgments: Array<Record<string, unknown>> };
  assert.equal(analysisOutput.schema_version, "clue.intelligence-analysis.output.v2");
  assert.equal(analysisOutput.status, "final");
  assert.equal(analysisOutput.judgments.length, 1);
  const analysisInput = JSON.parse(
    fs.readFileSync(manifest.paths.analysis_input, "utf8"),
  ) as { model: string; model_reasoning_effort: string };
  assert.equal(analysisInput.model, "synthetic-model");
  assert.equal(analysisInput.model_reasoning_effort, "low");
  const claim = analysisOutput.judgments[0]!;
  assert.deepEqual((claim as { evidence: Array<Record<string, unknown>> }).evidence.map((item) => item.clue_id), [
    "paper-alpha",
    "paper-beta",
  ]);
  const reportInput = JSON.parse(
    fs.readFileSync(manifest.paths.report_input, "utf8"),
  ) as { report_id: string };
  assert.equal(reportInput.report_id, "synthetic-report");
  const reportReviews = JSON.parse(
    fs.readFileSync(manifest.paths.report_reviews, "utf8"),
  ) as { reviews: Array<{ status: string }>; summary: { pass_count: number } };
  assert.equal(reportReviews.reviews.length, 4);
  assert.ok(reportReviews.reviews.every((review) => review.status === "pass"));
  assert.equal(reportReviews.summary.pass_count, 4);
  const publishedReport = JSON.parse(
    fs.readFileSync(manifest.paths.report_manifest, "utf8"),
  ) as { status: string; report_id: string };
  assert.equal(publishedReport.status, "published");
  assert.equal(publishedReport.report_id, "synthetic-report");

  for (const key of [
    "collection_output",
    "analysis_input",
    "analysis_output",
    "report_input",
    "report_draft",
    "report_reviews",
    "report_markdown",
    "report_manifest",
    "report_tex",
    "report_bib",
    "report_pdf",
    "run_manifest",
  ]) {
    assert.equal(fs.existsSync(manifest.paths[key]!), true, key);
  }
  assert.ok(fs.statSync(manifest.paths.report_pdf!).size > 0);

  const codexLog = JSON.parse(fs.readFileSync(codexLogPath, "utf8")) as {
    wanghai_keys: string[];
    workflow_root: string;
  };
  assert.deepEqual(codexLog.wanghai_keys, []);
  assert.equal(codexLog.workflow_root, WORKFLOW_ROOT);
});

test("Polaris resumes a pending analysis review and continues the report stage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-literature-review-resume-"));
  const workspaceRoot = path.join(root, "workspaces");
  const workspace = path.join(workspaceRoot, "research-demo");
  const cacheRoot = path.join(root, "cache");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(cacheRoot, { recursive: true });

  const inputPath = path.join(root, "input.json");
  const collectionOutputPath = path.join(root, "collection-output.json");
  const input = JSON.parse(fs.readFileSync(EXAMPLE_INPUT, "utf8")) as Record<string, unknown>;
  input.collection_id = "synthetic-review-resume";
  input.question = "Which bounded behavior is supported by the review corpus?";
  input.decision_context = "Exercise the Polaris review continuation boundary.";
  input.pipeline = { review_mode: "manual-review", skip_augmentation: true };
  input.review_policy = {
    minimum_confidence: 0.75,
    review_all_claims: true,
    mode: "manual-review",
  };
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2));
  const collectionOutput = {
    schema_version: "clue.data-collection.output.v2",
    collection_id: "synthetic-review-resume",
    collection_kind: "literature",
    status: "final",
    records: [
      {
        record_id: "paper-review",
        record_kind: "literature-candidate",
        source_url: "https://source.example/review",
        observed_at: "2026-01-03T00:00:00Z",
        content_hash: "sha256:review",
        evidence: [{ quote: "The review fixture supports bounded behavior.", locator: "abstract" }],
        payload: {
          title: "Synthetic review paper",
          author: [{ given: "R", family: "Reviewer" }],
          year: 2025,
        },
      },
    ],
    rejected_records: [],
    run_artifacts: [],
    information_gaps: [],
  };
  fs.writeFileSync(collectionOutputPath, JSON.stringify(collectionOutput, null, 2));

  const environment = cleanEnvironment();
  environment.POLARIS_LITERATURE_WORKSPACES_ROOT = workspaceRoot;
  environment.POLARIS_LITERATURE_CACHE_ROOT = cacheRoot;
  environment.POLARIS_LITERATURE_RUNTIME_MODE = "local";
  environment.POLARIS_LITERATURE_CODEX_BIN = FAKE_CODEX;
  const initial = spawnSync(
    path.join(WORKFLOW_ROOT, "polaris-literature-review"),
    [
      "run",
      "--input",
      inputPath,
      "--collection-output",
      collectionOutputPath,
      "--workspace",
      "research-demo",
      "--run-id",
      "review-resume",
      "--analysis-id",
      "review-analysis",
      "--report-id",
      "review-report",
      "--network",
      "deny",
      "--review-mode",
      "manual-review",
      "--literature-method",
      "iterate",
      "--report-mode",
      "fixed",
      "--template",
      "literature-report",
    ],
    { cwd: REPO_ROOT, env: environment, encoding: "utf8" },
  );
  assert.equal(initial.status, 0, initial.stderr);
  const pending = JSON.parse(initial.stdout) as {
    status: string;
    paths: Record<string, string>;
  };
  assert.equal(pending.status, "pending_manual_review");
  const validatedPath = path.join(
    path.dirname(pending.paths.analysis_input),
    "..",
    "work",
    "validated.json",
  );
  const validated = JSON.parse(fs.readFileSync(validatedPath, "utf8")) as {
    claims: Array<{
      claim_id: string;
      review: { review_key: string; revision_hash: string };
    }>;
    snapshot_id?: string;
  };
  assert.equal(validated.claims.length, 1);
  const claim = validated.claims[0]!;
  const invalidReviewResultPath = path.join(root, "invalid-review-result.json");
  fs.writeFileSync(invalidReviewResultPath, JSON.stringify({ schema_version: "invalid" }));
  const invalidResume = spawnSync(
    path.join(WORKFLOW_ROOT, "polaris-literature-review"),
    [
      "complete-analysis-review",
      "--run-manifest",
      pending.paths.run_manifest,
      "--review-result",
      invalidReviewResultPath,
    ],
    { cwd: REPO_ROOT, env: environment, encoding: "utf8" },
  );
  assert.equal(invalidResume.status, 2);
  const retryableManifest = JSON.parse(
    fs.readFileSync(pending.paths.run_manifest!, "utf8"),
  ) as { status: string; pending_stage?: string; resumable?: boolean };
  assert.equal(retryableManifest.status, "pending_manual_review");
  assert.equal(retryableManifest.pending_stage, "analysis");
  assert.equal(retryableManifest.resumable, true);
  const savedReview = spawnSync(
    path.join(WORKFLOW_ROOT, "polaris-literature-review"),
    [
      "analysis-review",
      "save",
      "--run-manifest",
      pending.paths.run_manifest,
      "--record-id",
      claim.claim_id,
      "--status",
      "approved",
      "--note",
      "Synthetic Polaris approval.",
    ],
    { cwd: REPO_ROOT, env: environment, encoding: "utf8" },
  );
  assert.equal(savedReview.status, 0, savedReview.stderr);
  const exportedReview = spawnSync(
    path.join(WORKFLOW_ROOT, "polaris-literature-review"),
    ["analysis-review", "export", "--run-manifest", pending.paths.run_manifest],
    { cwd: REPO_ROOT, env: environment, encoding: "utf8" },
  );
  assert.equal(exportedReview.status, 0, exportedReview.stderr);
  const resumed = spawnSync(
    path.join(WORKFLOW_ROOT, "polaris-literature-review"),
    [
      "complete-analysis-review",
      "--run-manifest",
      pending.paths.run_manifest,
      "--codex-bin",
      FAKE_CODEX,
    ],
    { cwd: REPO_ROOT, env: environment, encoding: "utf8" },
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  const completed = JSON.parse(resumed.stdout) as {
    status: string;
    stages: Array<{ stage: string; status: string }>;
    paths: Record<string, string>;
  };
  assert.equal(completed.status, "succeeded");
  assert.ok(
    completed.stages.some(
      (stage) => stage.stage === "analysis-review" && stage.status === "completed",
    ),
  );
  assert.ok(fs.statSync(completed.paths.report_pdf!).size > 0);
});

test("the migrated source contains no Wanghai package import or executable reference", () => {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!["__pycache__", ".pytest_cache", "node_modules"].includes(entry.name)) visit(target);
      } else if (/\.(py|mjs|sh|json|md|ts|ord)$/u.test(entry.name)) {
        files.push(target);
      }
    }
  };
  visit(WORKFLOW_ROOT);
  visit(COMMON_TOOLS_ROOT);
  visit(path.join(REPO_ROOT, "schemas"));
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /@wanghai|tools\/wanghai/u, file);
  }
});
