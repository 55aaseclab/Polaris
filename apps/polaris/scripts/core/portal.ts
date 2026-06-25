import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { loadWorkspace } from "../config/load.js";
import {
  readWorkspaceDriverSelection,
  workspaceSelectionPath,
  workspaceStateDir,
  workspaceStatusPath,
} from "../output/state-store.js";
import type { Credential, WorkspaceStatus } from "./workspace.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../");
const USER_ROOT = path.join(REPO_ROOT, "config", "users");
const USER_PROFILES_DIR = path.join(USER_ROOT, "profiles");

export type PortalBackendKind = "docker" | "pod" | "kubevirt-vm";
export type PortalPodProfile = "gvisor" | "data-container";

export interface PortalDriverTarget {
  backend: PortalBackendKind;
  profile?: string;
}

export interface PortalProfileSummary {
  id: string;
  name: string;
  email: string;
  workspaces: string[];
}

export interface PortalProfileDetail extends PortalProfileSummary {
  githubAccount?: string;
  sshMode?: string;
  sshComment?: string;
}

export interface PortalCredentialSummary {
  id: string;
  kind: Credential["kind"];
  label: string;
  purposes: string[];
  status: string;
  paths: string[];
}

export interface PortalProvisionProgress {
  workspace: string;
  userId: string;
  phase: string;
  step: number;
  totalSteps: number;
  percent: number;
  message: string;
  updatedAt: string;
  done: boolean;
  error?: string;
}

export interface PortalWorkspaceSummary {
  name: string;
  drivers: PortalDriverTarget[];
  selectedDriver: PortalDriverTarget | null;
  status: WorkspaceStatus | null;
  progress: PortalProvisionProgress | null;
  liveTarget: string | null;
}

export interface PortalWorkspaceDetail extends PortalWorkspaceSummary {
  resolvedWorkspace: WorkspaceStatus | null;
  availableDrivers: Array<PortalDriverTarget & { available: boolean }>;
  credentialBindings: Array<{
    purpose: string;
    credentialId: string;
    required: boolean;
  }>;
}

export const PORTAL_DRIVER_TARGETS: PortalDriverTarget[] = [
  { backend: "docker" },
  { backend: "pod", profile: "gvisor" },
  { backend: "pod", profile: "data-container" },
  { backend: "kubevirt-vm" },
];

function userProjectsRoot(userId: string): string {
  return path.join(USER_ROOT, userId, "projects");
}

function workspaceRoot(userId: string, workspace: string): string {
  return path.join(userProjectsRoot(userId), workspace);
}

function workspaceBackendFile(target: PortalDriverTarget): string {
  if (target.backend === "pod") {
    return "pod.agent.yaml";
  }
  if (target.backend === "kubevirt-vm") {
    return "kubevirt.agent.yaml";
  }
  return "docker.agent.yaml";
}

function portalStateFile(userId: string, workspace: string): string {
  return path.join(workspaceStateDir(workspace, userId), "portal.json");
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readYAML(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return (yaml.load(fs.readFileSync(filePath, "utf8")) ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeYAML(filePath: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    yaml.dump(value, { lineWidth: 120, noRefs: true }),
    "utf8",
  );
}

function profilePath(userId: string): string {
  return path.join(USER_PROFILES_DIR, `${userId}.yaml`);
}

function parseDriverTarget(backend: string, profile?: string): PortalDriverTarget {
  if (backend === "pod" && profile) {
    return { backend: "pod", profile };
  }
  if (backend === "kubevirt-vm" || backend === "docker") {
    return { backend };
  }
  return { backend: "docker" };
}

export function parsePortalDriverTarget(value: string): PortalDriverTarget {
  const [backend, profile] = value.split(":", 2);
  return parseDriverTarget(backend, profile);
}

export function formatDriverTarget(target: PortalDriverTarget): string {
  return target.backend === "pod" && target.profile
    ? `pod:${target.profile}`
    : target.backend;
}

export function workspaceRefFromTarget(workspace: string, target: PortalDriverTarget): string {
  return target.backend === "pod" && target.profile
    ? `${workspace}@pod:${target.profile}`
    : `${workspace}@${target.backend}`;
}

export function listPortalProfiles(): PortalProfileSummary[] {
  if (!fs.existsSync(USER_PROFILES_DIR)) {
    return [];
  }
  return fs
    .readdirSync(USER_PROFILES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => {
      const id = entry.name.replace(/\.ya?ml$/, "");
      const data = readYAML(path.join(USER_PROFILES_DIR, entry.name)) ?? {};
      return {
        id,
        name: String(data.name ?? ""),
        email: String(data.email ?? ""),
        workspaces: Array.isArray(data.workspaces)
          ? data.workspaces.map((value) => String(value)).filter(Boolean)
          : [],
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function readPortalProfile(userId: string): PortalProfileDetail | null {
  const data = readYAML(profilePath(userId));
  if (!data) {
    return null;
  }
  return {
    id: userId,
    name: String(data.name ?? ""),
    email: String(data.email ?? ""),
    workspaces: Array.isArray(data.workspaces)
      ? data.workspaces.map((value) => String(value)).filter(Boolean)
      : [],
    githubAccount: typeof data.github === "object" && data.github
      ? String((data.github as Record<string, unknown>).account ?? "") || undefined
      : undefined,
    sshMode: typeof data.ssh === "object" && data.ssh
      ? String((data.ssh as Record<string, unknown>).mode ?? "") || undefined
      : undefined,
    sshComment: typeof data.ssh === "object" && data.ssh
      ? String((data.ssh as Record<string, unknown>).comment ?? "") || undefined
      : undefined,
  };
}

export function updatePortalProfile(
  userId: string,
  patch: {
    name?: string;
    email?: string;
    githubAccount?: string;
    sshComment?: string;
  },
): PortalProfileDetail {
  const filePath = profilePath(userId);
  const current = readYAML(filePath);
  if (!current) {
    throw new Error(`User profile '${userId}' was not found`);
  }
  const next = { ...current };
  if (patch.name !== undefined) {
    next.name = patch.name;
  }
  if (patch.email !== undefined) {
    next.email = patch.email;
  }
  const currentGithub = typeof next.github === "object" && next.github
    ? { ...(next.github as Record<string, unknown>) }
    : {};
  if (patch.githubAccount !== undefined) {
    currentGithub.account = patch.githubAccount;
    next.github = currentGithub;
  }
  const currentSsh = typeof next.ssh === "object" && next.ssh
    ? { ...(next.ssh as Record<string, unknown>) }
    : {};
  if (patch.sshComment !== undefined) {
    currentSsh.comment = patch.sshComment;
    next.ssh = currentSsh;
  }
  writeYAML(filePath, next);
  const updated = readPortalProfile(userId);
  if (!updated) {
    throw new Error(`User profile '${userId}' could not be reloaded`);
  }
  return updated;
}

export function resolvePolarisUserIdFromIdentity(params: {
  clerkUserId?: string;
  email?: string;
  routeUserId?: string;
}): string | null {
  const profiles = listPortalProfiles();
  const directId = params.routeUserId?.trim();
  if (directId && profiles.some((profile) => profile.id === directId)) {
    return directId;
  }
  const clerkUserId = params.clerkUserId?.trim();
  if (clerkUserId && profiles.some((profile) => profile.id === clerkUserId)) {
    return clerkUserId;
  }
  const email = params.email?.trim().toLowerCase();
  if (email) {
    const match = profiles.find((profile) => profile.email.toLowerCase() === email);
    if (match) {
      return match.id;
    }
  }
  return null;
}

export function listOwnedWorkspaces(userId: string): string[] {
  const root = userProjectsRoot(userId);
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export function listWorkspaceDriverTargets(userId: string, workspace: string): Array<PortalDriverTarget & { available: boolean }> {
  const root = workspaceRoot(userId, workspace);
  return PORTAL_DRIVER_TARGETS.map((target) => ({
    ...target,
    available: fs.existsSync(path.join(root, workspaceBackendFile(target))) || fs.existsSync(root),
  }));
}

export function readWorkspaceSelection(userId: string, workspace: string): PortalDriverTarget | null {
  const selection = readWorkspaceDriverSelection(workspace, userId);
  if (!selection) {
    return null;
  }
  return parseDriverTarget(selection.backend, selection.profile);
}

export function readWorkspaceStatus(userId: string, workspace: string): WorkspaceStatus | null {
  return readJson<WorkspaceStatus>(workspaceStatusPath(workspace, userId));
}

export function readWorkspaceProvisionProgress(userId: string, workspace: string): PortalProvisionProgress | null {
  return readJson<PortalProvisionProgress>(portalStateFile(userId, workspace));
}

export function writeWorkspaceProvisionProgress(
  userId: string,
  workspace: string,
  progress: PortalProvisionProgress,
): string {
  const filePath = portalStateFile(userId, workspace);
  writeJson(filePath, progress);
  return filePath;
}

export function clearWorkspaceProvisionProgress(userId: string, workspace: string): void {
  fs.rmSync(portalStateFile(userId, workspace), { force: true });
}

export function resolveLiveTarget(status: WorkspaceStatus | null): string | null {
  return status?.daemon?.pairing?.url ?? null;
}

export function listPortalCredentials(userId: string): PortalCredentialSummary[] {
  const credentialsRoot = path.join(USER_ROOT, userId, "credentials");
  if (!fs.existsSync(credentialsRoot)) {
    return [];
  }
  return fs
    .readdirSync(credentialsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => {
      const data = readYAML(path.join(credentialsRoot, entry.name)) ?? {};
      const material = data.materialRef as Record<string, unknown> | undefined;
      const files = Array.isArray(material?.files)
        ? material?.files as Array<Record<string, unknown>>
        : [];
      return {
        id: String(data.id ?? entry.name.replace(/\.ya?ml$/, "")),
        kind: String(data.kind ?? "unknown") as Credential["kind"],
        label: String(data.label ?? entry.name),
        purposes: Array.isArray(data.purposes)
          ? data.purposes.map((value) => String(value)).filter(Boolean)
          : [],
        status: String(data.status ?? "unknown"),
        paths: files.map((file) => String(file.source_path ?? file.sourcePath ?? file.key ?? "" )).filter(Boolean),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function loadWorkspaceSummary(userId: string, workspace: string): PortalWorkspaceSummary {
  const status = readWorkspaceStatus(userId, workspace);
  return {
    name: workspace,
    drivers: PORTAL_DRIVER_TARGETS,
    selectedDriver: readWorkspaceSelection(userId, workspace),
    status,
    progress: readWorkspaceProvisionProgress(userId, workspace),
    liveTarget: resolveLiveTarget(status),
  };
}

export function loadWorkspaceDetail(userId: string, workspace: string): PortalWorkspaceDetail {
  const summary = loadWorkspaceSummary(userId, workspace);
  let resolvedWorkspace: WorkspaceStatus | null = summary.status;
  let bindings: PortalWorkspaceDetail["credentialBindings"] = [];
  const selectedDriver = summary.selectedDriver;
  const preferredTargets = [
    selectedDriver,
    { backend: "docker" as const },
    { backend: "pod" as const, profile: "gvisor" },
    { backend: "kubevirt-vm" as const },
  ].filter(Boolean) as PortalDriverTarget[];
  for (const target of preferredTargets) {
    try {
      const loaded = loadWorkspace(workspaceRefFromTarget(workspace, target));
      bindings = loaded.resolvedCredentialBindings.map((binding) => ({
        purpose: binding.purpose,
        credentialId: binding.credentialId,
        required: binding.required,
      }));
      break;
    } catch {
      continue;
    }
  }
  return {
    ...summary,
    resolvedWorkspace,
    availableDrivers: listWorkspaceDriverTargets(userId, workspace),
    credentialBindings: bindings,
  };
}
