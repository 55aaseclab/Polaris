import type { DurableAttachment, VaultSpec } from "./vault.js";
import { vaultRuntimeScopeName } from "./vault-name.js";

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

export function dockerNetfsServer(source: AttachmentSource): string {
  const server = requireNetfsField(
    source.server,
    "server",
    "vault-data",
  );
  return server === "netfs.local" ? "127.0.0.1" : server;
}

export function dockerNetfsDevicePath(source: AttachmentSource): string {
  return `:${netfsResolvedPath(source)}`;
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

export function vaultDataClaimName(vault: VaultSpec): string {
  const runtimeScope = vaultRuntimeScopeName(
    vault.userProfile.id,
    vault.identity.projectName,
  );
  return vault.attachments.vaultData.source.volumeRef?.trim()
    || `${runtimeScope}-vault-data`;
}

export function vaultDataDockerVolumeName(vault: VaultSpec): string {
  const runtimeScope = vaultRuntimeScopeName(
    vault.userProfile.id,
    vault.identity.projectName,
  );
  return vault.attachments.vaultData.source.volumeRef?.trim()
    || `${runtimeScope}-vault-data`;
}

export function vaultDataPersistentVolumeName(
  vault: VaultSpec,
): string {
  return `${vaultDataClaimName(vault)}-pv`;
}
