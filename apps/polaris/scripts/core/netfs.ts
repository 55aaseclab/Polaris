import type { DurableAttachment, WorkspaceSpec } from "./workspace.js";

type AttachmentSource = DurableAttachment["source"];

function trimSlashes(value: string): string {
  return value.replace(/^\/+/, "").replace(/\/+$/, "");
}

export function isNetfsSource(source: AttachmentSource): boolean {
  return source.kind === "netfs";
}

export function defaultNetfsMountOptions(): string[] {
  return ["nfsvers=4.1", "hard", "rw"];
}

export function netfsMountOptions(source: AttachmentSource): string[] {
  const options = source.mountOptions?.map((entry) => entry.trim()).filter(Boolean);
  return options?.length ? options : defaultNetfsMountOptions();
}

export function requireNetfsField(
  value: string | undefined,
  field: "server" | "exportPath",
  attachmentKind: string,
): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${attachmentKind} netfs source requires '${field}'`);
  }
  return normalized;
}

export function netfsResolvedPath(source: AttachmentSource): string {
  const exportPath = requireNetfsField(source.exportPath, "exportPath", "workspace-data");
  const base = exportPath.endsWith("/") ? exportPath.slice(0, -1) : exportPath;
  const subPath = trimSlashes(source.subPath?.trim() ?? "");
  return subPath ? `${base}/${subPath}` : base;
}

export function workspaceDataClaimName(workspace: WorkspaceSpec): string {
  return workspace.attachments.workspaceData.source.volumeRef?.trim()
    || `${workspace.identity.projectName}-workspace-data`;
}

export function workspaceDataDockerVolumeName(workspace: WorkspaceSpec): string {
  return workspace.attachments.workspaceData.source.volumeRef?.trim()
    || `${workspace.identity.projectName}-workspace-data`;
}

export function workspaceDataPersistentVolumeName(
  workspace: WorkspaceSpec,
): string {
  return `${workspaceDataClaimName(workspace)}-pv`;
}
