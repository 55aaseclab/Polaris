import "server-only";

import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@polaris/business-core";

export type WorkspaceType = "unclassified" | "ecommerce" | "research";

export type PrebuiltWorkflowManifestEntry = {
  chain: string[];
  icon: string;
  id: string;
  scenario: string;
  summary: string;
  title: string;
  todos: string[];
};

export type PrebuiltWorkflowManifestDocument = {
  schema: "wanghai.workspace-prebuilt-workflows";
  schema_version: 1;
  workspace_types: WorkspaceType[];
  workflows: PrebuiltWorkflowManifestEntry[];
};

const MANIFEST_NAME = "workspace-prebuilt-workflows.json";

export function listPrebuiltWorkflows(workspaceType: WorkspaceType | null): PrebuiltWorkflowManifestEntry[] {
  if (!workspaceType) return [];
  const documents = discoverWorkflowManifests(REPO_ROOT)
    .map(readWorkflowManifest)
    .filter((document): document is PrebuiltWorkflowManifestDocument => document !== null)
    .filter((document) => document.workspace_types.includes(workspaceType));

  return documents.flatMap((document) => document.workflows);
}

function discoverWorkflowManifests(repoRoot: string): string[] {
  const manifests: string[] = [];
  const directCandidates = [
    path.join(repoRoot, MANIFEST_NAME),
    path.join(repoRoot, "third_party", "syssec-research-skills", MANIFEST_NAME),
  ];

  for (const candidate of directCandidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) manifests.push(candidate);
  }

  const thirdPartyRoot = path.join(repoRoot, "third_party");
  if (!fs.existsSync(thirdPartyRoot) || !fs.statSync(thirdPartyRoot).isDirectory()) return manifests;

  for (const entry of fs.readdirSync(thirdPartyRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(thirdPartyRoot, entry.name, MANIFEST_NAME);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    if (!manifests.includes(candidate)) manifests.push(candidate);
  }
  return manifests;
}

function readWorkflowManifest(filePath: string): PrebuiltWorkflowManifestDocument | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isManifestDocument(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isManifestDocument(value: unknown): value is PrebuiltWorkflowManifestDocument {
  if (!isRecord(value)) return false;
  if (value.schema !== "wanghai.workspace-prebuilt-workflows") return false;
  if (value.schema_version !== 1) return false;
  if (!Array.isArray(value.workspace_types) || !value.workspace_types.every(isWorkspaceType)) return false;
  if (!Array.isArray(value.workflows) || !value.workflows.every(isWorkflowEntry)) return false;
  return true;
}

function isWorkflowEntry(value: unknown): value is PrebuiltWorkflowManifestEntry {
  if (!isRecord(value)) return false;
  return isStringArray(value.chain)
    && isNonEmptyString(value.icon)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.scenario)
    && isNonEmptyString(value.summary)
    && isNonEmptyString(value.title)
    && isStringArray(value.todos);
}

function isWorkspaceType(value: unknown): value is WorkspaceType {
  return value === "unclassified" || value === "ecommerce" || value === "research";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
