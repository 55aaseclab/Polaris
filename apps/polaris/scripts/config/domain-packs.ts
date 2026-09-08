import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  flattenDomain,
  normalizeVersion,
  resolvePort,
  runPipeline,
  satisfies,
  type DomainAccent,
  type PackSource,
  type PipelineResult,
  type PortAst,
  type InputFieldAst,
  type TrialAst,
} from "polaris-workflow";
import { withControlMutationLock } from "../utils/control-mutation-lock.js";
import {
  polarisDataRoot,
  polarisDomainPacksRoot,
} from "../utils/paths.js";

const DOMAIN_PACK_KIND = "polaris-domain-pack";
const DOMAIN_PACK_SCHEMA_VERSION = 1;
const DOMAIN_PACK_SOURCE_FILE = "main.ord";
const DOMAIN_PACK_MANIFEST_FILE = "manifest.json";
const DOMAIN_ID_PATTERN = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface DomainPackManifest {
  kind: typeof DOMAIN_PACK_KIND;
  schemaVersion: typeof DOMAIN_PACK_SCHEMA_VERSION;
  id: string;
  version: string;
  title?: string;
  description?: string;
  source: typeof DOMAIN_PACK_SOURCE_FILE;
  sha256: string;
  installedAt: string;
}

export interface DomainPackSummary {
  id: string;
  version: string;
  title?: string;
  description?: string;
  sha256: string;
  installedAt: string;
  status: "verified" | "drifted";
  storagePath: string;
  sourcePath: string;
}

export interface DomainPackInstallResult {
  pack: DomainPackSummary;
  warnings: string[];
}

export interface DomainPackFlowProjection {
  id: string;
  title: string;
  summary: string;
  estimate: string;
  approvalRequired: boolean;
  groupId?: string;
  groupTitle?: string;
  toolCalls: Array<{
    id: string;
    port: string;
    version: string;
    effect: PortAst["effect"];
    builtin?: string;
    unresolved: boolean;
  }>;
  fields: Array<{
    id: string;
    label: string;
    type: "text" | "textarea";
    placeholder: string;
    required: boolean;
  }>;
}

export interface DomainPackTrialProjection {
  id: string;
  title: string;
  nodeCount: number;
  edgeCount: number;
  terminalNodes: string[];
  capabilities: string[];
  budget: TrialAst["budget"];
  execution: TrialAst["execution"];
}

export interface DomainPackProjection {
  id: string;
  title: string;
  category: string;
  description: string;
  version: string;
  languageVersion: string;
  digest: string;
  capabilities: string[];
  accent: DomainAccent;
  flows: DomainPackFlowProjection[];
  trials: DomainPackTrialProjection[];
}

interface StoredDomainPack extends DomainPackSummary {
  source: string;
  sourcePathAbsolute: string;
}

function capabilityLabel(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
}

function accentFromDigest(digest: string): DomainAccent {
  const accents: DomainAccent[] = ["green", "blue", "amber"];
  const value = Number.parseInt(digest.slice(0, 2), 16);
  return accents[Number.isNaN(value) ? 0 : value % accents.length];
}

function inputControlType(input: InputFieldAst): "text" | "textarea" {
  return input.inputKind ?? "text";
}

function portForStep(
  ports: PortAst[],
  flowStep: { call?: { name: string; version?: string } },
): PortAst | null {
  if (!flowStep.call) return null;
  return resolvePort(ports, flowStep.call.name, flowStep.call.version);
}

function flowToolCalls(
  ports: PortAst[],
  flowSteps: readonly { id: string; call?: { name: string; version?: string } }[],
): DomainPackFlowProjection["toolCalls"] {
  return flowSteps
    .filter((step) => step.call)
    .map((step) => {
      const port = step.call ? resolvePort(ports, step.call.name, step.call.version) : null;
      const portName = port?.qualifiedName ?? port?.name ?? step.call?.name ?? "unknown";
      const portVersion = port?.version ?? step.call?.version ?? "1.0.0";
      return {
        id: step.id,
        port: portName,
        version: portVersion,
        effect: port?.effect ?? "ffi",
        ...(port?.builtin ? { builtin: port.builtin } : {}),
        unresolved: port == null,
      };
    });
}

function assertDomainPackId(value: string): string {
  const id = value.trim();
  if (!DOMAIN_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid Domain Pack id '${value}'; use a Unicode letter/underscore followed by letters, numbers, or underscores`,
    );
  }
  return id;
}

function canonicalPackVersion(value: string): string {
  const version = normalizeVersion(value);
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`Invalid Domain Pack version '${value}'`);
  }
  return version;
}

function storageRelativePath(
  dataRoot: string,
  packRoot: string,
): string {
  return path.relative(dataRoot, packRoot).split(path.sep).join("/");
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function assertNotSymlink(filePath: string, label: string): void {
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Domain Pack ${label} must not be a symbolic link: ${filePath}`);
  }
}

function readManifest(
  manifestPath: string,
  expectedId: string,
  expectedVersion: string,
): DomainPackManifest {
  assertNotSymlink(manifestPath, "manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read Domain Pack manifest '${manifestPath}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Domain Pack manifest is not an object: ${manifestPath}`);
  }
  const document = parsed as Record<string, unknown>;
  if (document.kind !== DOMAIN_PACK_KIND || document.schemaVersion !== DOMAIN_PACK_SCHEMA_VERSION) {
    throw new Error(`Unsupported Domain Pack manifest: ${manifestPath}`);
  }
  const id = typeof document.id === "string" ? document.id.trim() : "";
  const rawVersion = typeof document.version === "string"
    ? document.version.trim()
    : "";
  const version = rawVersion ? canonicalPackVersion(rawVersion) : "";
  const source = typeof document.source === "string" ? document.source.trim() : "";
  const digest = typeof document.sha256 === "string" ? document.sha256.trim() : "";
  const installedAt = typeof document.installedAt === "string"
    ? document.installedAt.trim()
    : "";
  if (
    id !== expectedId
    || version !== expectedVersion
    || source !== DOMAIN_PACK_SOURCE_FILE
    || !SHA256_PATTERN.test(digest)
    || !installedAt
  ) {
    throw new Error(`Domain Pack manifest does not match its storage path: ${manifestPath}`);
  }
  if (id !== assertDomainPackId(id)) {
    throw new Error(`Invalid Domain Pack id in manifest: ${manifestPath}`);
  }
  return {
    kind: DOMAIN_PACK_KIND,
    schemaVersion: DOMAIN_PACK_SCHEMA_VERSION,
    id,
    version,
    ...(typeof document.title === "string" && document.title.trim()
      ? { title: document.title.trim() }
      : {}),
    ...(typeof document.description === "string" && document.description.trim()
      ? { description: document.description.trim() }
      : {}),
    source: DOMAIN_PACK_SOURCE_FILE,
    sha256: digest,
    installedAt,
  };
}

function readStoredDomainPacks(
  importMetaUrl: string,
  environment: NodeJS.ProcessEnv,
): StoredDomainPack[] {
  const root = polarisDomainPacksRoot(importMetaUrl, environment);
  const dataRoot = polarisDataRoot(importMetaUrl, environment);
  if (!fs.existsSync(root)) {
    return [];
  }
  assertNotSymlink(root, "root");

  const stored: StoredDomainPack[] = [];
  for (const domainEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (domainEntry.name.startsWith(".")) {
      continue;
    }
    if (!domainEntry.isDirectory()) {
      throw new Error(`Unexpected entry in Domain Pack root: ${domainEntry.name}`);
    }
    const id = assertDomainPackId(domainEntry.name);
    const domainRoot = path.join(root, id);
    assertNotSymlink(domainRoot, "domain directory");
    for (const versionEntry of fs.readdirSync(domainRoot, { withFileTypes: true })) {
      if (versionEntry.name.startsWith(".")) {
        continue;
      }
      if (!versionEntry.isDirectory()) {
        throw new Error(`Unexpected entry in Domain Pack directory: ${domainEntry.name}/${versionEntry.name}`);
      }
      const version = canonicalPackVersion(versionEntry.name);
      const packRoot = path.join(domainRoot, version);
      assertNotSymlink(packRoot, "version directory");
      const manifestPath = path.join(packRoot, DOMAIN_PACK_MANIFEST_FILE);
      const sourcePathAbsolute = path.join(packRoot, DOMAIN_PACK_SOURCE_FILE);
      if (!fs.existsSync(manifestPath) || !fs.existsSync(sourcePathAbsolute)) {
        throw new Error(`Incomplete Domain Pack installation: ${packRoot}`);
      }
      const manifest = readManifest(manifestPath, id, version);
      assertNotSymlink(sourcePathAbsolute, "source");
      const source = fs.readFileSync(sourcePathAbsolute, "utf8");
      stored.push({
        id: manifest.id,
        version: manifest.version,
        ...(manifest.title ? { title: manifest.title } : {}),
        ...(manifest.description ? { description: manifest.description } : {}),
        sha256: manifest.sha256,
        installedAt: manifest.installedAt,
        status: sha256(source) === manifest.sha256 ? "verified" : "drifted",
        storagePath: storageRelativePath(dataRoot, packRoot),
        sourcePath: storageRelativePath(dataRoot, sourcePathAbsolute),
        source,
        sourcePathAbsolute,
      });
    }
  }
  return stored.sort((a, b) =>
    a.id.localeCompare(b.id) || compareVersions(b.version, a.version));
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function packLoader(
  installed: StoredDomainPack[],
): (domainName: string, versionRange?: string) => PackSource | null {
  const candidates = new Map<string, StoredDomainPack[]>();
  for (const pack of installed) {
    if (pack.status !== "verified") {
      continue;
    }
    const versions = candidates.get(pack.id) ?? [];
    versions.push(pack);
    candidates.set(pack.id, versions);
  }
  for (const versions of candidates.values()) {
    versions.sort((a, b) => compareVersions(b.version, a.version));
  }
  return (domainName, versionRange) => {
    const pack = candidates.get(domainName)
      ?.find((candidate) => !versionRange || satisfies(candidate.version, versionRange));
    return pack
      ? { source: pack.source, path: pack.sourcePath }
      : null;
  };
}

function resolveInputSource(inputPath: string): { source: string; path: string } {
  const resolved = path.resolve(process.cwd(), inputPath.trim());
  if (!fs.existsSync(resolved)) {
    throw new Error(`Domain Pack source was not found: ${inputPath}`);
  }
  assertNotSymlink(resolved, "input");
  const stats = fs.statSync(resolved);
  const sourcePath = stats.isDirectory()
    ? path.join(resolved, DOMAIN_PACK_SOURCE_FILE)
    : resolved;
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Domain Pack directory must contain ${DOMAIN_PACK_SOURCE_FILE}: ${resolved}`);
  }
  assertNotSymlink(sourcePath, "input source");
  if (!fs.statSync(sourcePath).isFile()) {
    throw new Error(`Domain Pack source is not a file: ${sourcePath}`);
  }
  return { source: fs.readFileSync(sourcePath, "utf8"), path: sourcePath };
}

function formatPipelineFailure(result: PipelineResult): string {
  const errors = [
    ...result.parseErrors.map((error) => error.message),
    ...result.issues
      .filter((issue) => issue.level === "error")
      .map((issue) => `${issue.code}: ${issue.message}`),
  ];
  return errors.length > 0
    ? errors.join("; ")
    : "unknown DSL validation error";
}

function summaryFromStored(pack: StoredDomainPack): DomainPackSummary {
  const {
    source: _source,
    sourcePathAbsolute: _sourcePathAbsolute,
    ...summary
  } = pack;
  return summary;
}

export function listDomainPacks(
  importMetaUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): DomainPackSummary[] {
  return readStoredDomainPacks(importMetaUrl, environment).map(summaryFromStored);
}

export function listDomainPackProjections(
  importMetaUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): DomainPackProjection[] {
  const installed = readStoredDomainPacks(importMetaUrl, environment);
  const loader = packLoader(installed);
  const projections: DomainPackProjection[] = [];
  for (const pack of installed) {
    if (pack.status !== "verified") continue;
    const pipeline = runPipeline(pack.source, { loader });
    if (!pipeline.ok || !pipeline.ast) continue;
    const flattened = flattenDomain(pipeline.ast);
    const ports = flattened.ports;
    const flows = flattened.flows.map((flow) => {
      const module = pipeline.ast?.modules.find((candidate) => candidate.name === flow.module);
      const groupId = module?.code || module?.name;
      return {
        id: flow.name,
        title: flow.title,
        summary: flow.description ?? `${flow.steps.length} 个阶段的工作流`,
        estimate: `${flow.steps.length} 个阶段`,
        approvalRequired: flow.steps.some((step) => portForStep(ports, step)?.effect === "human"),
        ...(groupId ? { groupId, groupTitle: module?.title } : {}),
        toolCalls: flowToolCalls(ports, flow.steps),
        fields: flow.inputs.map((input) => ({
          id: input.name,
          label: input.label ?? input.name,
          type: inputControlType(input),
          placeholder: input.placeholder ?? "",
          required: Boolean(input.required),
        })),
      };
    });
    const trials = (pipeline.ast.trials ?? []).map((trial) => ({
      id: trial.name,
      title: trial.title,
      nodeCount: trial.nodes.length,
      edgeCount: trial.edges.length,
      terminalNodes: [...trial.terminal],
      capabilities: [...new Set(trial.nodes.flatMap((node) => node.capabilities))],
      budget: { ...trial.budget },
      execution: { ...trial.execution },
    }));
    projections.push({
      id: pack.id,
      title: pipeline.ast.title ?? pack.title ?? pack.id,
      category: pipeline.ast.category ?? "Workflow",
      description: pipeline.ast.description ?? pack.description ?? "",
      version: pack.version,
      languageVersion: pipeline.ast.languageVersion ?? "0.3",
      digest: `sha256:${pack.sha256}`,
      capabilities: [...new Set(ports.map((port) => capabilityLabel(port.name)))],
      accent: pipeline.ast.accent ?? accentFromDigest(pack.sha256),
      flows,
      trials,
    });
  }
  return projections.sort((a, b) => a.title.localeCompare(b.title));
}

export interface VerifiedDomainPackRuntime {
  summary: DomainPackSummary;
  source: string;
  pipeline: PipelineResult;
}

/** Load exactly the installed bytes named by a run's immutable pack pin. */
export function loadVerifiedDomainPackRuntime(
  importMetaUrl: string,
  idInput: string,
  versionInput: string,
  digestInput: string,
  environment: NodeJS.ProcessEnv = process.env,
): VerifiedDomainPackRuntime {
  const id = assertDomainPackId(idInput);
  const version = canonicalPackVersion(versionInput);
  const digest = digestInput.trim().replace(/^sha256:/u, "");
  const installed = readStoredDomainPacks(importMetaUrl, environment);
  const pack = installed.find((candidate) =>
    candidate.id === id
    && candidate.version === version
    && candidate.status === "verified"
    && candidate.sha256 === digest,
  );
  if (!pack) {
    throw new Error(`Verified Domain Pack pin is unavailable: ${id}@${version} sha256:${digest}`);
  }
  const pipeline = runPipeline(pack.source, { loader: packLoader(installed) });
  if (!pipeline.ok || !pipeline.program || !pipeline.ast) {
    throw new Error(`Pinned Domain Pack cannot be executed: ${id}@${version}`);
  }
  return {
    summary: summaryFromStored(pack),
    source: pack.source,
    pipeline,
  };
}

export async function addDomainPack(
  importMetaUrl: string,
  inputPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DomainPackInstallResult> {
  return withControlMutationLock(importMetaUrl, "domain-packs", async () => {
    const input = resolveInputSource(inputPath);
    const installed = readStoredDomainPacks(importMetaUrl, environment);
    const pipeline = runPipeline(input.source, { loader: packLoader(installed) });
    if (!pipeline.ok || !pipeline.rawAst) {
      throw new Error(`Domain Pack validation failed for '${input.path}': ${formatPipelineFailure(pipeline)}`);
    }

    const id = assertDomainPackId(pipeline.rawAst.name);
    const version = canonicalPackVersion(pipeline.rawAst.version);
    const root = polarisDomainPacksRoot(importMetaUrl, environment);
    const dataRoot = polarisDataRoot(importMetaUrl, environment);
    const domainRoot = path.join(root, id);
    const targetRoot = path.join(domainRoot, version);
    if (fs.existsSync(domainRoot)) {
      assertNotSymlink(domainRoot, "domain directory");
    }
    if (fs.existsSync(targetRoot)) {
      throw new Error(`Domain Pack '${id}@${version}' is already installed`);
    }

    ensurePrivateDirectory(root);
    ensurePrivateDirectory(domainRoot);
    const temporaryRoot = path.join(
      root,
      `.${id}-${version}-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
    );
    const digest = sha256(input.source);
    const installedAt = new Date().toISOString();
    const manifest: DomainPackManifest = {
      kind: DOMAIN_PACK_KIND,
      schemaVersion: DOMAIN_PACK_SCHEMA_VERSION,
      id,
      version,
      ...(pipeline.rawAst.title ? { title: pipeline.rawAst.title } : {}),
      ...(pipeline.rawAst.description ? { description: pipeline.rawAst.description } : {}),
      source: DOMAIN_PACK_SOURCE_FILE,
      sha256: digest,
      installedAt,
    };

    ensurePrivateDirectory(temporaryRoot);
    try {
      const sourcePath = path.join(temporaryRoot, DOMAIN_PACK_SOURCE_FILE);
      const manifestPath = path.join(temporaryRoot, DOMAIN_PACK_MANIFEST_FILE);
      fs.writeFileSync(sourcePath, input.source, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(sourcePath, 0o600);
      fs.writeFileSync(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      fs.chmodSync(manifestPath, 0o600);
      fs.renameSync(temporaryRoot, targetRoot);
    } catch (error) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      throw error;
    }

    const pack = readStoredDomainPacks(importMetaUrl, environment)
      .find((candidate) => candidate.id === id && candidate.version === version);
    if (!pack) {
      throw new Error(`Domain Pack '${id}@${version}' was not visible after installation`);
    }
    return {
      pack: summaryFromStored(pack),
      warnings: pipeline.issues
        .filter((issue) => issue.level === "warning")
        .map((issue) => `${issue.code}: ${issue.message}`),
    };
  }, environment);
}

export async function removeDomainPack(
  importMetaUrl: string,
  idInput: string,
  versionInput: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Pick<DomainPackSummary, "id" | "version" | "storagePath"> & { removed: true }> {
  return withControlMutationLock(importMetaUrl, "domain-packs", async () => {
    const id = assertDomainPackId(idInput);
    const installed = readStoredDomainPacks(importMetaUrl, environment)
      .filter((pack) => pack.id === id);
    if (installed.length === 0) {
      throw new Error(`Domain Pack '${id}' is not installed`);
    }
    let target: StoredDomainPack | undefined;
    if (versionInput) {
      const version = canonicalPackVersion(versionInput);
      target = installed.find((pack) => pack.version === version);
      if (!target) {
        throw new Error(`Domain Pack '${id}@${version}' is not installed`);
      }
    } else if (installed.length === 1) {
      target = installed[0];
    } else {
      throw new Error(
        `Domain Pack '${id}' has multiple installed versions; pass --version <x.y.z>`,
      );
    }

    const root = polarisDomainPacksRoot(importMetaUrl, environment);
    const targetRoot = path.join(root, id, target.version);
    assertNotSymlink(targetRoot, "version directory");
    fs.rmSync(targetRoot, { recursive: true, force: false });
    const domainRoot = path.join(root, id);
    if (fs.existsSync(domainRoot) && fs.readdirSync(domainRoot).length === 0) {
      fs.rmSync(domainRoot, { recursive: true, force: false });
    }
    return {
      id: target.id,
      version: target.version,
      removed: true,
      storagePath: target.storagePath,
    };
  }, environment);
}
