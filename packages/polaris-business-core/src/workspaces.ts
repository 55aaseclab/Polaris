import fs from "node:fs";
import path from "node:path";
import { getWorkspacesDir } from "./repo.js";
import { initializeWorkspaceVersion } from "./workspace-version.js";

export const STANDARD_MODULES = [
  "市场调研",
  "产品管理",
  "订单管理",
  "seo-ops",
] as const;
export const CONFIGURED_WORKSPACE_TYPES = ["ecommerce", "research"] as const;
export const WORKSPACE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

const WORKSPACE_METADATA_FILE = "workspace.json";
const WORKSPACE_LAYOUT_FILE = "workspace-layout.json";
export const WORKSPACE_ASSETS_DIR = "assets";
export const WORKSPACE_WORKFLOWS_FILE = "workflows.yaml";
export const WORKSPACE_WORKFLOWS_DIR = "workflows";
const PORTAL_METADATA_SCHEMA = "wanghai.workspace";
const WORKSPACE_LAYOUT_SCHEMA = "clue.workspace.layout.v3";
const WORKSPACE_LAYOUT_VERSION = 3;
const WORKSPACE_LAYOUT_DIRECTORIES: Record<string, string> = {
  "assets/市场调研": "市场调研资产目录。",
  "assets/产品管理/产品库": "产品库资产目录。",
  "assets/产品管理/商品素材": "产品素材资产目录。",
  "assets/产品管理/交付归档": "交付归档资产目录。",
  "assets/订单管理": "订单资产目录。",
  "assets/seo-ops/case": "SEO 运营规则与说明。",
  "assets/seo-ops/sites": "长期运营的网站资产目录。",
  workflows: "workflow 实例、运行状态与阶段产物根目录。",
};

export type WorkspaceModule = (typeof STANDARD_MODULES)[number];
export type ConfiguredWorkspaceType = (typeof CONFIGURED_WORKSPACE_TYPES)[number];
export type WorkspaceType = ConfiguredWorkspaceType | "unclassified";
export type WorkspaceSummary = {
  name: string;
  path: string;
  type: WorkspaceType;
};

export type CreateWorkspaceOptions = {
  customer?: string | null;
  description?: string | null;
  rootDir?: string;
  type: ConfiguredWorkspaceType;
  workspace: string;
};

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function workspacePositioning(type: ConfiguredWorkspaceType) {
  if (type === "research") {
    return {
      category: "research-workspace",
      mode: "human-in-the-loop",
      goal: "先把资料、工作流和报告流程跑通，再逐步自动化",
    };
  }
  return {
    category: "ecommerce-automation-rpa",
    mode: "human-in-the-loop",
    goal: "先把调研、产品、订单流程跑通，再逐步自动化",
  };
}

function initialWorkspaceMetadata(
  workspace: string,
  type: ConfiguredWorkspaceType,
  updatedAt: string,
): Record<string, unknown> {
  return {
    schema: PORTAL_METADATA_SCHEMA,
    schema_version: 2,
    name: workspace,
    type,
    updated_at: updatedAt.slice(0, 10),
    positioning: workspacePositioning(type),
    modules: {
      "市场调研": "assets/市场调研",
      "产品管理": {
        "产品库": "assets/产品管理/产品库",
        "商品素材": "assets/产品管理/商品素材",
        "交付归档": "assets/产品管理/交付归档",
      },
      "订单管理": "assets/订单管理",
      "seo-ops": "assets/seo-ops",
    },
    compatibility_aliases: {
      research: "assets/市场调研",
      promo: "assets/产品管理/商品素材",
      deliverables: "assets/产品管理/交付归档",
      seo: "assets/seo-ops",
    },
  };
}

function initialWorkspaceLayout(
  workspace: string,
  customer: string,
  description: string,
  createdAt: string,
): Record<string, unknown> {
  return {
    schema: WORKSPACE_LAYOUT_SCHEMA,
    schema_version: WORKSPACE_LAYOUT_VERSION,
    layout_version: WORKSPACE_LAYOUT_VERSION,
    workspace_id: workspace,
    customer: { name: customer },
    description,
    status: "active",
    created_at: createdAt,
    updated_at: createdAt,
    managed_scopes: [
      "assets/市场调研",
      "assets/产品管理",
      "assets/订单管理",
      "assets/seo-ops",
      "workflows",
    ],
    required_directories: { ...WORKSPACE_LAYOUT_DIRECTORIES },
    history: [
      {
        at: createdAt,
        action: "created",
        tool: {
          name: "admin-portal",
          version: "workspace-api.v1",
        },
      },
    ],
  };
}

function writeJson(pathname: string, payload: Record<string, unknown>) {
  fs.writeFileSync(pathname, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeWorkspaceReadme(workspaceDir: string, customer: string) {
  const readmePath = path.join(workspaceDir, "README.md");
  if (fs.existsSync(readmePath)) return;

  const lines = [
    `# ${customer}`,
    "",
    "这是一个 portal 兼容的 workspace。",
    "根目录保存元数据；业务资产放在 `assets/`，workflow 运行数据放在 `workflows/`。",
    "",
    "## 目录",
    "",
    ...Object.entries(WORKSPACE_LAYOUT_DIRECTORIES).map(
      ([name, description]) => `- \`${name}/\`：${description}`,
    ),
    "",
  ];
  fs.writeFileSync(readmePath, `${lines.join("\n")}\n`, "utf8");
}

export function validateWorkspaceId(workspace: string): string {
  const normalized = workspace.trim();
  if (!WORKSPACE_ID_PATTERN.test(normalized)) {
    throw new Error("workspace id must match ^[a-z][a-z0-9-]{0,62}$");
  }
  return normalized;
}

export class WorkspacePaths {
  constructor(readonly root: string) {}

  get assetsDir(): string {
    return this.workspacePath(WORKSPACE_ASSETS_DIR);
  }

  get workflowConfigFile(): string {
    return this.workspacePath(WORKSPACE_WORKFLOWS_FILE);
  }

  get workflowsDir(): string {
    return this.workspacePath(WORKSPACE_WORKFLOWS_DIR);
  }

  get marketResearchDir(): string {
    return this.preferredModuleDir("市场调研");
  }

  get productManagementDir(): string {
    return this.preferredModuleDir("产品管理");
  }

  get productLibraryDir(): string {
    return this.workspacePathFrom(this.productManagementDir, "产品库");
  }

  get orderManagementDir(): string {
    return this.preferredModuleDir("订单管理");
  }

  get invoiceManagementDir(): string {
    return this.workspacePath("订单管理");
  }

  get logisticsManagementDir(): string {
    return this.workspacePath("订单管理");
  }

  get promoDir(): string {
    return this.workspacePathFrom(this.productManagementDir, "商品素材");
  }

  get researchDir(): string {
    return this.workspacePathFrom(this.marketResearchDir, "社交媒体运营");
  }

  get deliverablesDir(): string {
    return this.workspacePathFrom(this.productManagementDir, "交付归档");
  }

  get promoBatchesDir(): string {
    return this.workspacePathFrom(this.promoDir, "batches");
  }

  get promoLatestFile(): string {
    return this.workspacePathFrom(this.promoDir, "LATEST");
  }

  get seoOpsDir(): string {
    return this.preferredModuleDir("seo-ops");
  }

  get seoSitesDir(): string {
    return this.workspacePathFrom(this.seoOpsDir, "sites");
  }

  moduleDir(moduleName: WorkspaceModule): string {
    return this.preferredModuleDir(moduleName);
  }

  private preferredModuleDir(moduleName: WorkspaceModule): string {
    const preferred = this.workspacePath(WORKSPACE_ASSETS_DIR, moduleName);
    const legacy = this.workspacePath(moduleName);
    if (fs.existsSync(preferred) || !fs.existsSync(legacy)) {
      return preferred;
    }
    return legacy;
  }

  private workspacePath(...segments: string[]): string {
    return safeWorkspacePath(this.root, path.join(...segments));
  }

  private workspacePathFrom(parent: string, ...segments: string[]): string {
    return safeWorkspacePath(
      this.root,
      path.relative(this.root, path.join(parent, ...segments)),
    );
  }
}

export function isWorkspaceDir(dirPath: string): boolean {
  const metadataPath = path.join(dirPath, WORKSPACE_METADATA_FILE);
  try {
    return fs.statSync(dirPath).isDirectory() && fs.statSync(metadataPath).isFile();
  } catch {
    return false;
  }
}

export function workspaceTypeFromValue(value: unknown): WorkspaceType {
  return CONFIGURED_WORKSPACE_TYPES.includes(value as ConfiguredWorkspaceType) ? value as WorkspaceType : "unclassified";
}

function readWorkspaceType(workspaceDir: string): WorkspaceType {
  const metadataPath = path.join(workspaceDir, WORKSPACE_METADATA_FILE);
  if (!fs.existsSync(metadataPath) || !fs.statSync(metadataPath).isFile()) {
    return "unclassified";
  }
  try {
    const payload = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as unknown;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return "unclassified";
    }
    return workspaceTypeFromValue((payload as { type?: unknown }).type);
  } catch {
    return "unclassified";
  }
}

export function listWorkspaces(rootDir = getWorkspacesDir()): {
  name: string;
  path: string;
  type: WorkspaceType;
}[] {
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) return [];
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && WORKSPACE_ID_PATTERN.test(entry.name))
    .map((entry) => {
      const workspacePath = path.join(root, entry.name);
      return {
        name: entry.name,
        path: workspacePath,
        type: readWorkspaceType(workspacePath),
      };
    })
    .filter((entry) => isWorkspaceDir(entry.path) && realPathStaysWithin(root, entry.path))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function createWorkspace(options: CreateWorkspaceOptions): WorkspaceSummary {
  const rootDir = path.resolve(options.rootDir ?? getWorkspacesDir());
  const workspace = validateWorkspaceId(options.workspace);
  const customer = options.customer?.trim() || workspace;
  const description = options.description?.trim() ?? "";
  const target = path.join(rootDir, workspace);

  if (!CONFIGURED_WORKSPACE_TYPES.includes(options.type)) {
    throw new Error(`unsupported workspace type: ${options.type}`);
  }
  if (fs.existsSync(rootDir) && !fs.statSync(rootDir).isDirectory()) {
    throw new Error(`workspace root is not a directory: ${rootDir}`);
  }
  if (fs.existsSync(target)) {
    throw new Error(`workspace already exists: ${workspace}`);
  }

  const createdAt = utcNow();
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(target, { recursive: false });

  try {
    for (const directory of Object.keys(WORKSPACE_LAYOUT_DIRECTORIES)) {
      fs.mkdirSync(path.join(target, directory), { recursive: true });
    }
    writeJson(
      path.join(target, WORKSPACE_METADATA_FILE),
      initialWorkspaceMetadata(workspace, options.type, createdAt),
    );
    writeJson(
      path.join(target, WORKSPACE_LAYOUT_FILE),
      initialWorkspaceLayout(workspace, customer, description, createdAt),
    );
    writeWorkspaceReadme(target, customer);
    initializeWorkspaceVersion(target, 1);
  } catch (error) {
    fs.rmSync(target, { force: true, recursive: true });
    throw error;
  }

  return {
    name: workspace,
    path: target,
    type: options.type,
  };
}

export function resolveWorkspacePath(workspaceArg: string): string {
  const workspace = validateWorkspaceId(workspaceArg);
  const root = getWorkspacesDir();
  const target = safeWorkspacePath(root, workspace);
  if (isWorkspaceDir(target) && realPathStaysWithin(root, target)) return target;
  throw new Error(`Workspace not found: ${workspace}`);
}

export function safeWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const value = String(relativePath ?? "");
  if (!value || value.includes("\0") || path.isAbsolute(value)) {
    throw new Error("Workspace path must be relative");
  }
  if (value.includes("\\") || /%[0-9a-f]{2}/iu.test(value)) {
    throw new Error("Workspace path must not contain encoded or platform traversal segments");
  }
  if (value.split("/").some((segment) => segment === "..")) {
    throw new Error("Workspace path resolves outside workspace");
  }
  const resolved = path.resolve(workspaceRoot, value);
  const root = path.resolve(workspaceRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Workspace path resolves outside workspace");
  }
  if (!realPathStaysWithin(root, resolved)) {
    throw new Error("Workspace path resolves through a symlink outside workspace");
  }
  return resolved;
}

export function workspaceRelativePath(workspaceRoot: string, targetPath: string): string {
  if (!realPathStaysWithin(workspaceRoot, targetPath)) {
    throw new Error("Workspace path resolves outside workspace");
  }
  const rel = path.relative(workspaceRoot, targetPath);
  return rel.split(path.sep).join("/");
}

function realPathStaysWithin(workspaceRoot: string, targetPath: string): boolean {
  try {
    const root = fs.realpathSync(path.resolve(workspaceRoot));
    const existing = nearestExistingPath(path.resolve(targetPath));
    const resolved = fs.realpathSync(existing);
    return resolved === root || resolved.startsWith(`${root}${path.sep}`);
  } catch {
    return false;
  }
}

function nearestExistingPath(candidate: string): string {
  let current = candidate;
  while (!pathEntryExists(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Workspace path does not have an existing parent");
    }
    current = parent;
  }
  return current;
}

function pathEntryExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}
