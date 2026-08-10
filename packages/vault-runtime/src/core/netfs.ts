import type { AttachmentSource, VaultRuntimeSpec } from "../types.js";
import { vaultRuntimeScopeName } from "./vault-name.js";

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
  const exportPath = requireNetfsField(source.exportPath, "exportPath", "vault-data");
  const base = exportPath.endsWith("/") ? exportPath.slice(0, -1) : exportPath;
  const subPath = trimSlashes(source.subPath?.trim() ?? "");
  return subPath ? `${base}/${subPath}` : base;
}

export function dockerNetfsServer(source: AttachmentSource): string {
  const server = requireNetfsField(source.server, "server", "vault-data");
  return server === "netfs.local" ? "127.0.0.1" : server;
}

export function dockerNetfsDevicePath(source: AttachmentSource): string {
  return `:${netfsResolvedPath(source)}`;
}

export function vaultDataClaimName(spec: VaultRuntimeSpec): string {
  return spec.attachments.vaultData.source.volumeRef?.trim()
    || `${vaultRuntimeScopeName(spec.userProfile.id, spec.identity.projectName)}-vault-data`;
}

export function vaultDataDockerVolumeName(spec: VaultRuntimeSpec): string {
  return vaultDataClaimName(spec);
}

export function vaultDataPersistentVolumeName(spec: VaultRuntimeSpec): string {
  return `${vaultDataClaimName(spec)}-pv`;
}
