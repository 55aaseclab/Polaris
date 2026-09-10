import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../../utils/paths.js";
import { runPipeline, trialToDot, type DomainAst, type TrialAst } from "polaris-workflow";

const WORKFLOW_RELATIVE_PATH = path.join(
  "packs",
  "autoresearch",
  "main.ord",
);
const WORKFLOW_RUNTIME_RELATIVE_PATH = path.join(
  "packs",
  "autoresearch",
);
const COMMON_TOOLS_RELATIVE_PATH = "tools";
const PYTHON_ENTRY = "polaris-literature-review";

function usage(): never {
  throw new Error(
    "Usage: pnpm --dir apps/polaris run polaris -- literature-review "
      + "<version|tools|plan|validate|run|status|collection-review|"
      + "analysis-review|complete-collection-review|complete-analysis-review|"
      + "visualize|test> ...",
  );
}

type VisualizationFormat = "png" | "pdf";

interface VisualizationOptions {
  format: VisualizationFormat;
  output: string;
  envFile?: string;
}

function parseVisualizationOptions(argv: string[]): VisualizationOptions {
  let format: VisualizationFormat | undefined;
  let output: string | undefined;
  let envFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const inlineFormat = argument?.startsWith("--format=")
      ? argument.slice("--format=".length)
      : undefined;
    if (argument === "--format" || inlineFormat !== undefined) {
      if (format !== undefined) usage();
      const value = (inlineFormat ?? argv[index + 1])?.toLowerCase();
      if (value !== "png" && value !== "pdf") usage();
      format = value;
      if (inlineFormat === undefined) index += 1;
      continue;
    }
    const inlineOutput = argument?.startsWith("--output=")
      ? argument.slice("--output=".length)
      : undefined;
    if (argument === "--output" || argument === "-o" || inlineOutput !== undefined) {
      if (output !== undefined) usage();
      const value = (inlineOutput ?? argv[index + 1])?.trim();
      if (!value) usage();
      output = value;
      if (inlineOutput === undefined) index += 1;
      continue;
    }
    const inlineEnvFile = argument?.startsWith("--env-file=")
      ? argument.slice("--env-file=".length)
      : undefined;
    if (argument === "--env-file" || inlineEnvFile !== undefined) {
      if (envFile !== undefined) usage();
      const value = (inlineEnvFile ?? argv[index + 1])?.trim();
      if (!value) usage();
      envFile = value;
      if (inlineEnvFile === undefined) index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") usage();
    usage();
  }

  const extension = output ? path.extname(output).slice(1).toLowerCase() : "";
  if (!format && (extension === "png" || extension === "pdf")) {
    format = extension;
  }
  format ??= "png";
  if (extension && (extension === "png" || extension === "pdf") && extension !== format) {
    throw new Error(
      `Visualization output extension .${extension} does not match --format ${format}`,
    );
  }
  output ??= `literature-review-workflow.${format}`;
  return {
    format,
    output: path.resolve(output),
    ...(envFile ? { envFile: path.resolve(envFile) } : {}),
  };
}

function readVisualizationEnvFile(filePath: string): string | undefined {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read visualization env file ${filePath}: `
        + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?POLARIS_LITERATURE_GRAPHVIZ_BIN\s*=\s*(.*)$/u);
    if (!match) continue;
    return match[1]!.replace(/^(['"])(.*)\1$/u, "$2").trim() || undefined;
  }
  return undefined;
}

function visualizationRenderer(options: VisualizationOptions): string {
  const envFile = options.envFile
    ?? process.env.POLARIS_LITERATURE_ENV_FILE?.trim();
  const fromFile = envFile ? readVisualizationEnvFile(envFile) : undefined;
  return process.env.POLARIS_LITERATURE_GRAPHVIZ_BIN?.trim()
    || fromFile
    || "dot";
}

function hasFormatSignature(bytes: Buffer, format: VisualizationFormat): boolean {
  if (format === "pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).equals(bytes.subarray(0, 8));
}

function workflowRoot(): string {
  return path.join(repoRoot(import.meta.url), WORKFLOW_RUNTIME_RELATIVE_PATH);
}

function commonToolsRoot(): string {
  return path.join(repoRoot(import.meta.url), COMMON_TOOLS_RELATIVE_PATH);
}

function workflowPath(): string {
  return path.join(repoRoot(import.meta.url), WORKFLOW_RELATIVE_PATH);
}

function assertDefinition(): {
  source: string;
  definition: string;
  ast: DomainAst;
  trialName: string;
  digest: string;
  flows: string[];
  ports: string[];
  trial: TrialAst;
} {
  const definition = workflowPath();
  if (!fs.existsSync(definition)) {
    throw new Error(`Polaris literature workflow definition is missing: ${definition}`);
  }
  const source = fs.readFileSync(definition, "utf8");
  const pipeline = runPipeline(source);
  if (!pipeline.ok || !pipeline.ast || !pipeline.program) {
    const errors = [
      ...pipeline.parseErrors.map((error) => error.message),
      ...pipeline.issues
        .filter((issue) => issue.level === "error")
        .map((issue) => `${issue.code}: ${issue.message}`),
    ];
    throw new Error(
      `Polaris literature workflow definition is invalid: ${errors.join("; ")}`,
    );
  }
  const trial = pipeline.ast.trials?.find(
    (candidate) => candidate.name === "LiteratureReviewExecution",
  );
  if (!trial) {
    throw new Error(
      "Polaris literature workflow definition must contain "
      + "trial LiteratureReviewExecution",
    );
  }
  const digest = `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
  return {
    source,
    definition,
    ast: pipeline.ast,
    trialName: trial.name,
    digest,
    flows: pipeline.ast.flows.map((flow) => flow.name),
    ports: pipeline.ast.ports.map((port) => `${port.name}@${port.version}`),
    trial,
  };
}


function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("WANGHAI_")) {
      delete environment[key];
    }
  }
  environment.POLARIS_LITERATURE_WORKFLOW_ROOT = workflowRoot();
  environment.POLARIS_LITERATURE_TOOLS_ROOT = commonToolsRoot();
  return environment;
}

function runWorkflow(args: string[]): void {
  const root = workflowRoot();
  const executable = path.join(root, PYTHON_ENTRY);
  if (!fs.existsSync(executable)) {
    throw new Error(`Polaris literature workflow CLI is missing: ${executable}`);
  }
  try {
   execFileSync(executable, args, {
      cwd: repoRoot(import.meta.url),
      env: sanitizedEnvironment(),
      encoding: "utf8",
      stdio: "inherit",
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error) {
      const status = Number((error as { status?: unknown }).status ?? 1);
      throw new Error(`Polaris literature workflow exited with status ${status}`);
    }
    throw error;
  }
}

function runWorkflowCapture(args: string[]): string {
  const root = workflowRoot();
  const executable = path.join(root, PYTHON_ENTRY);
 const result = execFileSync(executable, args, {
    cwd: repoRoot(import.meta.url),
    env: sanitizedEnvironment(),
    encoding: "utf8",
  });
  return result;
}

function runWorkflowTests(): void {
  const root = workflowRoot();
  const tools = commonToolsRoot();
  const pythonPaths = [
    path.join(tools, "data-collection"),
    path.join(tools, "collection-review"),
    path.join(tools, "analysis-review"),
    path.join(tools, "intelligence-analysis"),
    path.join(tools, "intelligence-analysis", "literature-review"),
    path.join(tools, "report-writing"),
    path.join(tools, "crossref"),
    path.join(tools, "semantic-scholar"),
    path.join(tools, "deepsec"),
    path.join(tools, "codex"),
    path.join(tools, "image-review"),
    path.join(tools, "video-review"),
    path.join(tools, "social-media"),
  ];
  const environment = sanitizedEnvironment();
  // These are Polaris-owned offline contract tests.  They must remain
  // runnable even when the caller's integrated environment is fail-closed.
  environment.POLARIS_LITERATURE_RUNTIME_MODE = "local";
  environment.PYTHONPATH = [
    ...pythonPaths,
    ...(environment.PYTHONPATH ? [environment.PYTHONPATH] : []),
  ].join(path.delimiter);
  const testRoots = [
    path.join(tools, "intelligence-analysis", "literature-review", "tests"),
    path.join(tools, "intelligence-analysis", "tests"),
    path.join(tools, "report-writing", "tests"),
    path.join(tools, "data-collection", "tests"),
    path.join(tools, "collection-review", "tests"),
    path.join(tools, "analysis-review", "tests"),
    path.join(tools, "crossref", "tests"),
    path.join(tools, "semantic-scholar", "tests"),
    path.join(tools, "deepsec", "tests"),
    path.join(tools, "codex", "tests"),
    path.join(tools, "social-media", "tests"),
    path.join(tools, "image-review", "tests"),
    path.join(tools, "video-review", "tests"),
  ];
  for (const testRoot of testRoots) {
    execFileSync("python3", ["-m", "unittest", "discover", "-s", testRoot], {
      cwd: root,
      env: environment,
      stdio: "inherit",
    });
  }
  execFileSync("node", ["--test", path.join(tools, "browser", "tests", "runner.test.mjs")], {
    cwd: root,
    env: environment,
    stdio: "inherit",
  });
}

const LITERATURE_TRIAL_GROUPS = [
  {
    id: "collection",
    label: "Collection · source, augmentation, review",
    nodeIds: ["validateInput", "collectSources", "augmentCollection", "collectionReview"],
  },
  {
    id: "analysis",
    label: "Analysis · snapshot, claim graph, review",
    nodeIds: [
      "freezeSnapshot",
      "iterateClaims",
      "proposeBatches",
      "mergeBatches",
      "proposeClaims",
      "validateClaims",
      "analysisReview",
      "finalizeAnalysis",
    ],
  },
  {
    id: "report",
    label: "Report · draft, review, publication, PDF",
    nodeIds: [
      "prepareReport",
      "draftReport",
      "reviewReport",
      "reviseReport",
      "publishMarkdown",
      "renderPdf",
    ],
  },
] as const;

function visualizeLiteratureWorkflow(
  definition: ReturnType<typeof assertDefinition>,
  options: VisualizationOptions,
): void {
  const pipeline = definition.ast.pipelines[0];
  const source = trialToDot(definition.trial, definition.ast.ports, {
    metadata: [
      `domain: ${definition.ast.name}@${definition.ast.version}`,
      "DSL 0.4-trial · LiteratureReviewExecution",
      `flows: ${definition.flows.join(", ")}`,
      ...(pipeline
        ? [`pipeline: ${pipeline.name} (${pipeline.steps.join(" -> ")})`]
        : []),
      `ports: ${definition.ports.length}`,
    ],
    groups: LITERATURE_TRIAL_GROUPS,
  });
  const renderer = visualizationRenderer(options);
  const rendered = spawnSync(renderer, [`-T${options.format}`], {
    input: source,
    env: sanitizedEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (rendered.error) {
    if ((rendered.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Graphviz renderer '${renderer}' is not available; install Graphviz (dot) `
          + "or set POLARIS_LITERATURE_GRAPHVIZ_BIN",
      );
    }
    throw new Error(`Graphviz renderer '${renderer}' failed: ${rendered.error.message}`);
  }
  if (rendered.status !== 0) {
    const stderr = Buffer.isBuffer(rendered.stderr)
      ? rendered.stderr.toString("utf8").trim()
      : String(rendered.stderr ?? "").trim();
    throw new Error(
      `Graphviz renderer '${renderer}' exited with status ${rendered.status ?? "unknown"}`
        + (stderr ? `: ${stderr}` : ""),
    );
  }
  const bytes = Buffer.isBuffer(rendered.stdout)
    ? rendered.stdout
    : Buffer.from(rendered.stdout ?? "");
  if (bytes.length === 0) {
    throw new Error(`Graphviz renderer '${renderer}' produced an empty ${options.format} document`);
  }
  if (!hasFormatSignature(bytes, options.format)) {
    throw new Error(
      `Graphviz renderer '${renderer}' did not produce a valid ${options.format} document`,
    );
  }

  const outputPath = options.output;
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory()) {
    throw new Error(`Visualization output is a directory: ${outputPath}`);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  try {
    fs.writeFileSync(temporaryPath, bytes, { mode: 0o600 });
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  process.stdout.write(`${JSON.stringify({
    status: "rendered",
    workflow: definition.trialName,
    format: options.format,
    output: outputPath,
    bytes: bytes.length,
    nodes: definition.trial.nodes.length,
    edges: definition.trial.edges.length,
    definition_digest: definition.digest,
    renderer,
  }, null, 2)}\n`);
}

export async function literatureReviewCommand(argv: string[]): Promise<void> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    usage();
  }
  const definition = assertDefinition();

  if (command === "version") {
    if (argv.length !== 1) usage();
    const output = runWorkflowCapture(["version"]);
    const payload = JSON.parse(output) as Record<string, unknown>;
    process.stdout.write(
      `${JSON.stringify({
        ...payload,
        workflow_definition: {
          path: definition.definition,
          language_version: "0.4-trial",
          trial: definition.trialName,
          digest: definition.digest,
        },
      }, null, 2)}\n`,
    );
    return;
  }

  if (command === "validate") {
    if (argv.length !== 3 || argv[1] !== "--input") usage();
    runWorkflow(["validate", "--input", argv[2]!]);
    return;
  }

  if (command === "tools") {
    if (argv.length !== 1) usage();
    runWorkflow(["tools"]);
    return;
  }

  if (command === "plan") {
    if (argv.length !== 1) usage();
    process.stdout.write(`${JSON.stringify({
      status: "valid",
      workflow_definition: {
        path: definition.definition,
        digest: definition.digest,
        language_version: "0.4-trial",
        flows: definition.flows,
        ports: definition.ports,
        trial: {
          name: definition.trial.name,
          title: definition.trial.title,
          start: definition.trial.start,
          terminal: definition.trial.terminal,
          budget: definition.trial.budget,
          execution: definition.trial.execution,
          nodes: definition.trial.nodes.map((node) => ({
            id: node.id,
            role: node.role,
            call: node.call?.raw,
            uses: node.uses,
            outputs: node.outputs,
            retry: node.retry,
          })),
          edges: definition.trial.edges,
        },
      },
    }, null, 2)}\n`);
    return;
  }

  if (command === "visualize") {
    visualizeLiteratureWorkflow(definition, parseVisualizationOptions(argv.slice(1)));
    return;
  }

  if (command === "status") {
    if (argv.length !== 3 || argv[1] !== "--run-manifest") usage();
    runWorkflow(["status", "--run-manifest", argv[2]!]);
    return;
  }

  if (command === "collection-review") {
    if (argv.length < 2) usage();
    runWorkflow(argv);
    return;
  }

  if (command === "analysis-review") {
    if (argv.length < 2) usage();
    runWorkflow(argv);
    return;
  }

  if (command === "complete-collection-review") {
    if (!argv.includes("--run-manifest")) usage();
    runWorkflow(argv);
    return;
  }

  if (command === "complete-analysis-review") {
    if (!argv.includes("--run-manifest")) usage();
    runWorkflow(argv);
    return;
  }

  if (command === "test") {
    if (argv.length !== 1) usage();
    runWorkflowTests();
    return;
  }

  if (command === "run") {
    if (argv.length === 1) usage();
    runWorkflow(argv);
    return;
  }

  usage();
}
