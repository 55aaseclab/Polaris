import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import type { Readable } from "node:stream";
import type {
  WorkflowArtifactRecord,
  WorkflowEffectReceiptRecord,
  WorkflowRunRecord,
} from "./control-store.js";
import { polarisDataRoot, repoRoot } from "../utils/paths.js";

/** The migrated SysSec pack remains the user-facing entry point for reviews. */
export const SYSSEC_RESEARCH_PACK_ID = "SysSecResearch";
export const SYSSEC_LITERATURE_REVIEW_FLOW_ID = "LiteratureReview";

const WORKSPACE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_BRIEF_BYTES = 8 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_ARTIFACT_BYTES = 512 * 1024;
const HOST_WORKSPACE_DIRECTORY = "literature-host-workspaces";
const HOST_CACHE_DIRECTORY = "literature-host-cache";

// A host workflow is a child of the control plane, but it is not another
// control-plane process. Pass only runtime settings and the credentials that
// the reviewed literature tools explicitly support; in particular, do not
// inherit Authing, gateway, Vault, or deployment secrets by accident.
const HOST_CHILD_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "PYTHONPATH",
  "PYTHONUNBUFFERED",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "CODEX_BIN",
  "CODEX_CLI",
  "CODEX_MODEL",
  "LITERATURE_REVIEW_MODEL",
  "INTELLIGENCE_ANALYSIS_MODEL",
  "REPORT_WRITING_MODEL",
  "LITERATURE_REVIEW_REASONING_EFFORT",
  "REPORT_WRITING_REASONING_EFFORT",
  "SEMANTIC_SCHOLAR_API_KEY",
  "DEEPSEC_API_URL",
  "CROSSREF_API_URL",
  "LITERATURE_PDF_CACHE",
  "FFMPEG_BIN",
  "FFPROBE_BIN",
  "WHISPER_BIN",
  "JIEKOU_BASE_URL",
  "JIEKOU_API_BASE",
  "JIEKOU_API_KEY",
  "CAMOFOX_PORT",
  "BROWSER_CAMOFOX_PORT",
  "BROWSER_CAMOFOX_HOST",
  "BROWSER_CAMOFOX_URL",
  "BROWSER_PROXY_SERVER",
  "BROWSER_PROXY_USERNAME",
  "BROWSER_PROXY_PASSWORD",
  "POLARIS_TEST_CODEX_LOG",
]);

export function filterHostLiteratureEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== undefined
      && (HOST_CHILD_ENV_KEYS.has(key) || key.startsWith("POLARIS_LITERATURE_"))
    ) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export type HostLiteratureReviewProgress = {
  progress: number;
  stage: string;
  detail: string;
};

export type HostLiteratureReviewArtifact = Omit<
  WorkflowArtifactRecord,
  "runId" | "tenantId" | "createdAt"
>;

export type HostLiteratureReviewReceipt = Omit<
  WorkflowEffectReceiptRecord,
  "runId" | "tenantId"
>;

export type HostLiteratureReviewResult = {
  status: "succeeded" | "waiting";
  output: Record<string, unknown>;
  artifacts: HostLiteratureReviewArtifact[];
  receipts: HostLiteratureReviewReceipt[];
};

export type HostLiteratureReviewRequest = {
  importMetaUrl: string;
  run: Pick<
    WorkflowRunRecord,
    "id" | "tenantId" | "packId" | "packVersion" | "packDigest" | "flowId" | "input"
  >;
  signal: AbortSignal;
  onProgress?: (progress: HostLiteratureReviewProgress) => void;
};

export type HostLiteratureReviewExecutor = (
  request: HostLiteratureReviewRequest,
) => Promise<HostLiteratureReviewResult>;

export class HostLiteratureReviewCancelled extends Error {
  constructor() {
    super("Literature Review host execution was cancelled");
    this.name = "HostLiteratureReviewCancelled";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireText(value: unknown, label: string, maxBytes = MAX_BRIEF_BYTES): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required for host Literature Review`);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`${label} is too large for host Literature Review`);
  }
  return text;
}

function safeId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || !RUN_ID_PATTERN.test(normalized)) {
    throw new Error(`${label} is not a safe workflow identifier`);
  }
  return normalized;
}

function tenantWorkspaceId(tenantId: string): string {
  const digest = createHash("sha256").update(tenantId, "utf8").digest("hex").slice(0, 32);
  return `tenant-${digest}`;
}

function assertRealDirectory(directory: string, label: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function ensurePrivateDirectory(directory: string, label: string): void {
  if (fs.existsSync(directory)) {
    assertRealDirectory(directory, label);
  } else {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(directory, 0o700);
}

function configuredDirectory(
  importMetaUrl: string,
  environmentKey: string,
  fallbackDirectory: string,
): string {
  const configured = process.env[environmentKey]?.trim();
  if (configured) return path.resolve(configured);
  return path.join(polarisDataRoot(importMetaUrl), fallbackDirectory);
}

function hostRoots(request: HostLiteratureReviewRequest): {
  workspacesRoot: string;
  cacheRoot: string;
  workspaceId: string;
  workspace: string;
  runRoot: string;
} {
  const workspacesRoot = configuredDirectory(
    request.importMetaUrl,
    "POLARIS_LITERATURE_WORKSPACES_ROOT",
    HOST_WORKSPACE_DIRECTORY,
  );
  const cacheBase = configuredDirectory(
    request.importMetaUrl,
    "POLARIS_LITERATURE_CACHE_ROOT",
    HOST_CACHE_DIRECTORY,
  );
  ensurePrivateDirectory(workspacesRoot, "host Literature Review workspace root");
  ensurePrivateDirectory(cacheBase, "host Literature Review cache root");

  const workspaceId = tenantWorkspaceId(request.run.tenantId);
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error("derived host Literature Review workspace ID is invalid");
  }
  const workspace = path.join(workspacesRoot, workspaceId);
  ensurePrivateDirectory(workspace, "host Literature Review tenant workspace");
  const cacheRoot = path.join(cacheBase, workspaceId);
  ensurePrivateDirectory(cacheRoot, "host Literature Review tenant cache root");
  const runId = safeId(request.run.id, "run ID");
  const literatureRoot = path.join(workspace, "literature-review");
  ensurePrivateDirectory(literatureRoot, "host Literature Review workspace data root");
  const runRoot = path.join(literatureRoot, runId);
  if (fs.existsSync(runRoot)) assertRealDirectory(runRoot, "host Literature Review run root");
  ensurePrivateDirectory(runRoot, "host Literature Review run root");
  return { workspacesRoot, cacheRoot, workspaceId, workspace, runRoot };
}

function parseJsonObject(value: string, label: string): Record<string, unknown> | null {
  if (!value.trim().startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON when supplied as an object`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function integerOption(value: unknown, label: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function booleanOption(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  throw new Error("host Literature Review boolean option is invalid");
}

function optionChoice<T extends string>(value: unknown, label: string, choices: readonly T[], fallback: T): T {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!choices.includes(candidate as T)) {
    throw new Error(`${label} must be one of ${choices.join(", ")}`);
  }
  return candidate as T;
}

function defaultCollectionInput(
  request: HostLiteratureReviewRequest,
  brief: string,
): Record<string, unknown> {
  const values = request.run.input;
  const supplied = values.collectionInput || values.collection_input || values.inputJson;
  const suppliedObject = supplied ? parseJsonObject(supplied, "collectionInput") : null;
  if (suppliedObject) {
    if (suppliedObject.schema_version !== "clue.data-collection.input.v2") {
      throw new Error("collectionInput must use clue.data-collection.input.v2");
    }
    if (suppliedObject.collection_kind !== "literature") {
      throw new Error("collectionInput must use collection_kind=literature");
    }
    return structuredClone(suppliedObject);
  }

  const currentYear = new Date().getUTCFullYear();
  const fromYear = integerOption(values.fromYear, "fromYear", Math.max(1900, currentYear - 4), 1000, currentYear);
  const toYear = integerOption(values.toYear, "toYear", currentYear, fromYear, currentYear + 1);
  const rows = integerOption(values.rows, "rows", 20, 1, 100);
  const reviewMode = optionChoice(
    values.reviewMode,
    "reviewMode",
    ["auto-pass", "auto-approve", "manual-review"] as const,
    "auto-pass",
  );
  const skipAugmentation = booleanOption(
    values.skipAugmentation,
    booleanOption(process.env.POLARIS_LITERATURE_HOST_SKIP_AUGMENTATION, true),
  );
  const literatureMethod = optionChoice(
    values.literatureMethod,
    "literatureMethod",
    ["iterate", "batches", "propose"] as const,
    "iterate",
  );
  const reportMode = optionChoice(
    values.reportMode,
    "reportMode",
    ["fixed", "reviewed"] as const,
    "fixed",
  );
  const collectionId = `lr-${request.run.id.toLowerCase().replace(/[^a-z0-9-]/gu, "-").slice(0, 56)}`;
  return {
    schema_version: "clue.data-collection.input.v2",
    collection_id: collectionId,
    collection_kind: "literature",
    question: brief,
    decision_context: "Polaris host Literature Review",
    audience: values.audience?.trim() || "research and engineering",
    scope: {
      time_range: `${fromYear}..${toYear}`,
      include: [brief],
    },
    evidence_policy: {
      required_fields: ["source_url", "quote", "observed_at", "content_hash"],
    },
    source_tasks: [
      {
        task_id: "brief-crossref",
        source_type: "crossref-search",
        config: { query: brief, rows },
      },
      {
        task_id: "brief-semantic-scholar",
        source_type: "semantic-scholar-search",
        config: { query: brief, limit: rows },
      },
    ],
    payload: {
      literature_scope: {
        enabled: true,
        from_year: fromYear,
        to_year: toYear,
        topic_filter: false,
        max_records: rows,
      },
      pdf_links: { enabled: true },
    },
    pipeline: {
      review_mode: reviewMode,
      skip_augmentation: skipAugmentation,
    },
    literature_method: literatureMethod,
    report_mode: reportMode,
    report_template: values.reportTemplate?.trim() || "auto",
  };
}

/** Compile a user-facing SysSec brief into the canonical collection contract. */
export function compileHostLiteratureInput(
  request: HostLiteratureReviewRequest,
  briefInput?: string,
): Record<string, unknown> {
  const brief = requireText(briefInput || request.run.input.brief, "brief");
  return defaultCollectionInput(request, brief);
}

function writeJsonAtomically(filePath: string, value: Record<string, unknown>): void {
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
}

function appendBounded(current: string, chunk: Buffer): string {
  const combined = Buffer.concat([Buffer.from(current, "utf8"), chunk]);
  return combined.subarray(Math.max(0, combined.length - MAX_PROCESS_OUTPUT_BYTES)).toString("utf8");
}

function childEnvironment(
  request: HostLiteratureReviewRequest,
  roots: ReturnType<typeof hostRoots>,
): NodeJS.ProcessEnv {
  const environment = filterHostLiteratureEnvironment();
  environment.POLARIS_LITERATURE_WORKSPACES_ROOT = roots.workspacesRoot;
  environment.POLARIS_LITERATURE_CACHE_ROOT = roots.cacheRoot;
  environment.POLARIS_LITERATURE_PDF_CACHE = path.join(roots.cacheRoot, "pdf");
  environment.POLARIS_LITERATURE_RUNTIME_MODE = "local";
  environment.POLARIS_LITERATURE_WORKFLOW_ROOT = path.join(
    repoRoot(request.importMetaUrl),
    "workflows",
    "literature-review",
  );
  return environment;
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stageProgress(manifestPath: string): HostLiteratureReviewProgress | null {
  const manifest = readJsonFile(manifestPath);
  if (!manifest) return null;
  const stages = Array.isArray(manifest.stages)
    ? manifest.stages.filter(isRecord)
    : [];
  const latest = stages.at(-1);
  const stage = typeof latest?.stage === "string" ? latest.stage : "collection";
  const status = typeof latest?.status === "string" ? latest.status : "running";
  const ranges: Record<string, [number, number]> = {
    collection: [12, 42],
    analysis: [45, 72],
    "report-writing": [76, 96],
  };
  const [start, end] = ranges[stage] ?? [12, 96];
  const progress = status === "final" || status === "succeeded"
    ? end
    : Math.max(start, Math.min(end - 1, start + 4));
  return {
    progress,
    stage,
    detail: `Polaris host 正在处理 ${stage} 阶段（${status}）`,
  };
}

async function runChild(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(executable, args, {
      cwd: path.dirname(path.dirname(executable)),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`Literature Review host runner could not start: ${error instanceof Error ? error.message : String(error)}`);
  }

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout = appendBounded(stdout, Buffer.from(chunk)); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = appendBounded(stderr, Buffer.from(chunk)); });

  let cancelled = signal.aborted;
  const terminate = (): void => {
    cancelled = true;
    if (!child.killed) child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 5_000);
    killTimer.unref();
  };
  const onAbort = (): void => terminate();
  signal.addEventListener("abort", onAbort, { once: true });
  if (cancelled) terminate();

  const [status] = await once(child, "close") as [number | null, string | null];
  signal.removeEventListener("abort", onAbort);
  if (cancelled) throw new HostLiteratureReviewCancelled();
  return { status, stdout, stderr };
}

function fileWithin(root: string, candidate: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function publicReportManifest(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) return content;
    const projected = { ...parsed };
    if (typeof projected.report_path === "string") {
      projected.report_path = path.basename(projected.report_path);
    }
    return `${JSON.stringify(projected, null, 2)}\n`;
  } catch {
    return content;
  }
}

function artifactFromFile(
  runRoot: string,
  filePath: string | undefined,
  name: string,
  kind: WorkflowArtifactRecord["kind"],
  summary: string,
  redacted = false,
): HostLiteratureReviewArtifact | null {
  if (!filePath) return null;
  const safePath = fileWithin(runRoot, filePath);
  if (!safePath || !fs.existsSync(safePath)) return null;
  const stat = fs.lstatSync(safePath);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const bytes = fs.readFileSync(safePath);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  let content: string;
  if (name.endsWith(".pdf") || bytes.includes(0)) {
    content = `Binary artifact\nname: ${name}\nsize: ${formatBytes(bytes.length)}\ndigest: ${digest}`;
  } else {
    const text = bytes.toString("utf8");
    content = name === "report.json"
      ? publicReportManifest(text)
      : redacted
      ? `Redacted host artifact\nname: ${name}\nsize: ${formatBytes(bytes.length)}\ndigest: ${digest}`
      : text.length > MAX_TEXT_ARTIFACT_BYTES
        ? `${text.slice(0, MAX_TEXT_ARTIFACT_BYTES)}\n… [preview truncated]`
        : text;
  }
  return {
    id: `artifact-${safeId(path.basename(runRoot), "run ID")}-${name.replace(/[^a-z0-9.-]/giu, "-")}`,
    name,
    kind,
    size: formatBytes(bytes.length),
    summary,
    content,
    digest,
    redacted,
  };
}

function manifestPaths(manifest: Record<string, unknown>): Record<string, string> {
  const raw = manifest.paths;
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function findFilesByName(root: string, names: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0 && found.length < 64) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && names.has(entry.name)) {
        found.push(candidate);
      }
    }
  }
  return found;
}

function resultFromManifest(
  request: HostLiteratureReviewRequest,
  roots: ReturnType<typeof hostRoots>,
  manifest: Record<string, unknown>,
): HostLiteratureReviewResult {
  const paths = manifestPaths(manifest);
  const status = manifest.status === "pending_manual_review" ? "waiting" : "succeeded";
  const artifactSpecs: Array<[
    string,
    string,
    WorkflowArtifactRecord["kind"],
    string,
    boolean?,
  ]> = [
    ["report_markdown", "report.md", "report", "Polaris Literature Review Markdown report"],
    ["report_pdf", "report.pdf", "report", "Polaris Literature Review PDF"],
    ["report_manifest", "report.json", "data", "Published report manifest"],
    ["collection_output", "collection-output.json", "data", "Validated literature collection", true],
    ["analysis_output", "analysis-output.json", "data", "Evidence-bound analysis output", true],
  ];
  const artifacts = artifactSpecs.flatMap(([key, name, kind, summary, redacted]) => {
    const artifact = artifactFromFile(roots.runRoot, paths[key], name, kind, summary, redacted);
    return artifact ? [artifact] : [];
  });
  const knownNames = new Set(artifacts.map((artifact) => artifact.name));
  const runArtifacts = Array.isArray(manifest.run_artifacts)
    ? manifest.run_artifacts.filter(isRecord)
    : [];
  for (const entry of runArtifacts) {
    const sourcePath = typeof entry.path === "string" ? entry.path : undefined;
    const basename = sourcePath ? path.basename(sourcePath) : "";
    if (!sourcePath || !basename || knownNames.has(basename)) continue;
    // The fixed report operation writes its reviewed Markdown during the
    // analysis/report pipeline and records it as a run artifact rather than
    // under report_markdown. Present it under the stable Portal name.
    const name = basename === "literature-report.md" ? "report.md" : basename;
    if (knownNames.has(name)) continue;
    const kind: WorkflowArtifactRecord["kind"] = name.endsWith(".md") || name.endsWith(".pdf")
      ? "report"
      : "data";
    const artifact = artifactFromFile(
      roots.runRoot,
      sourcePath,
      name,
      kind,
      name.endsWith(".md") ? "Polaris Literature Review Markdown report" : "Literature Review run artifact",
      !name.endsWith(".md"),
    );
    if (artifact) {
      artifacts.push(artifact);
      knownNames.add(name);
    }
  }
  // The fixed report writer stores the Markdown alongside the analysis
  // checkpoint (`literature-report.md`), so it is not always listed in the
  // top-level workflow manifest. Discover only these fixed names below the
  // already-created run root; symlinks are ignored by the scanner and the
  // artifact reader applies the same containment check.
  for (const sourcePath of findFilesByName(roots.runRoot, new Set(["literature-report.md"]))) {
    if (knownNames.has("report.md")) continue;
    const artifact = artifactFromFile(
      roots.runRoot,
      sourcePath,
      "report.md",
      "report",
      "Polaris Literature Review Markdown report",
    );
    if (artifact) {
      artifacts.push(artifact);
      knownNames.add("report.md");
    }
  }
  if (status === "waiting") {
    const reviewPath = paths.collection_review_list || paths.analysis_review_list;
    const review = artifactFromFile(
      roots.runRoot,
      reviewPath,
      "manual-review-list.json",
      "data",
      "Polaris review decisions required before continuation",
      true,
    );
    if (review) artifacts.push(review);
  }
  const finishedAt = new Date().toISOString();
  const receipt: HostLiteratureReviewReceipt = {
    id: `receipt-${request.run.id}-literature-host`,
    requestId: `host-${request.run.id}`,
    port: "LiteratureReviewHost",
    version: "1.0.0",
    effect: "ffi",
    status: status === "waiting" ? "waiting" : "completed",
    input: {
      workflow: request.run.flowId,
      workspace: roots.workspaceId,
    },
    output: {
      status: manifest.status,
      artifactCount: artifacts.length,
    },
    createdAt: finishedAt,
    completedAt: finishedAt,
  };
  return {
    status,
    output: {
      execution: "host",
      workflow: manifest.workflow || "LiteratureReviewExecution",
      status: manifest.status || status,
      workspaceId: roots.workspaceId,
      runManifest: "run.json",
      artifactNames: artifacts.map((artifact) => artifact.name),
      stages: Array.isArray(manifest.stages)
        ? manifest.stages.filter(isRecord).map((stage) => ({
            stage: String(stage.stage || ""),
            status: String(stage.status || ""),
          }))
        : [],
    },
    artifacts,
    receipts: [receipt],
  };
}

function networkChoice(): "allow" | "deny" {
  const value = process.env.POLARIS_LITERATURE_HOST_NETWORK?.trim() || "allow";
  if (value !== "allow" && value !== "deny") {
    throw new Error("POLARIS_LITERATURE_HOST_NETWORK must be allow or deny");
  }
  return value;
}

function runnerArguments(
  request: HostLiteratureReviewRequest,
  roots: ReturnType<typeof hostRoots>,
  inputPath: string,
  input: Record<string, unknown>,
  collectionOutputPath?: string,
): string[] {
  const values = request.run.input;
  const reportMode = optionChoice(values.reportMode, "reportMode", ["fixed", "reviewed"] as const, "fixed");
  const method = optionChoice(values.literatureMethod, "literatureMethod", ["iterate", "batches", "propose"] as const, "iterate");
  const reviewMode = optionChoice(values.reviewMode, "reviewMode", ["auto-pass", "auto-approve", "manual-review"] as const, "auto-pass");
  const args = [
    "run",
    "--input", inputPath,
    "--workspace", roots.workspaceId,
    "--run-id", safeId(request.run.id, "run ID"),
    "--analysis-id", safeId(`${request.run.id}-analysis`, "analysis ID"),
    "--report-id", safeId(`${request.run.id}-report`, "report ID"),
    "--workspaces-root", roots.workspacesRoot,
    "--cache-root", roots.cacheRoot,
    "--runtime-mode", "local",
    "--network", networkChoice(),
    "--review-mode", reviewMode,
    "--literature-method", method,
    "--report-mode", reportMode,
    "--template", typeof input.report_template === "string" ? input.report_template : "auto",
    "--max-revisions", "2",
  ];
  if (booleanOption((input.pipeline as Record<string, unknown> | undefined)?.skip_augmentation, true)) {
    args.push("--skip-augmentation");
  }
  if (collectionOutputPath) args.push("--collection-output", collectionOutputPath);
  return args;
}

function manifestPathFor(roots: ReturnType<typeof hostRoots>, runId: string): string {
  return path.join(roots.runRoot, "run.json");
}

/** Execute the real migrated workflow directly on the Polaris host. */
export const executeHostLiteratureReview: HostLiteratureReviewExecutor = async (request) => {
  if (
    request.run.packId !== SYSSEC_RESEARCH_PACK_ID
    || request.run.flowId !== SYSSEC_LITERATURE_REVIEW_FLOW_ID
  ) {
    throw new Error("host Literature Review adapter received an unsupported workflow");
  }
  const roots = hostRoots(request);
  const input = compileHostLiteratureInput(request);
  const inputPath = path.join(roots.runRoot, "collection-input.json");
  writeJsonAtomically(inputPath, input);
  let collectionOutputPath: string | undefined;
  const suppliedCollectionOutput = request.run.input.collectionOutput || request.run.input.collection_output;
  if (suppliedCollectionOutput?.trim().startsWith("{")) {
    const collectionOutput = parseJsonObject(suppliedCollectionOutput, "collectionOutput");
    if (!collectionOutput) throw new Error("collectionOutput must be a JSON object");
    collectionOutputPath = path.join(roots.runRoot, "supplied-collection-output.json");
    writeJsonAtomically(collectionOutputPath, collectionOutput);
  }
  const manifestPath = manifestPathFor(roots, request.run.id);
  request.onProgress?.({ progress: 8, stage: "admission", detail: "已在 Polaris host 创建 Literature Review workspace" });

  const workflowExecutable = path.join(
    repoRoot(request.importMetaUrl),
    "workflows",
    "literature-review",
    "polaris-literature-review",
  );
  if (!fs.existsSync(workflowExecutable)) {
    throw new Error("Polaris literature-review host runner is missing");
  }
  const executableStat = fs.lstatSync(workflowExecutable);
  if (!executableStat.isFile() || executableStat.isSymbolicLink()) {
    throw new Error("Polaris literature-review host runner is not a regular file");
  }

  const environment = childEnvironment(request, roots);
  const args = runnerArguments(request, roots, inputPath, input, collectionOutputPath);
  request.onProgress?.({ progress: 12, stage: "startup", detail: "Polaris host runner 已启动" });
  const progressTimer = setInterval(() => {
    const progress = stageProgress(manifestPath);
    if (progress) request.onProgress?.(progress);
  }, 1_000);
  progressTimer.unref();
  let childResult: { status: number | null; stdout: string; stderr: string };
  try {
    childResult = await runChild(workflowExecutable, args, environment, request.signal);
  } finally {
    clearInterval(progressTimer);
  }
  if (childResult.status !== 0) {
    const detail = childResult.stderr.trim() || childResult.stdout.trim() || `exit ${childResult.status ?? "unknown"}`;
    throw new Error(`Polaris host Literature Review failed: ${detail.slice(-2_000)}`);
  }
  const manifest = readJsonFile(manifestPath);
  if (!manifest) throw new Error("Polaris host Literature Review did not produce a run manifest");
  if (manifest.status !== "succeeded" && manifest.status !== "pending_manual_review") {
    throw new Error(`Polaris host Literature Review ended with status ${String(manifest.status || "unknown")}`);
  }
  const result = resultFromManifest(request, roots, manifest);
  request.onProgress?.({ progress: result.status === "waiting" ? 96 : 100, stage: "complete", detail: result.status === "waiting" ? "等待 Polaris review continuation" : "Literature Review host execution 已完成" });
  return result;
};

export function isHostLiteratureReviewRun(
  run: Pick<WorkflowRunRecord, "packId" | "flowId" | "executionDriver">,
): boolean {
  return run.executionDriver === "none"
    && run.packId === SYSSEC_RESEARCH_PACK_ID
    && run.flowId === SYSSEC_LITERATURE_REVIEW_FLOW_ID;
}
