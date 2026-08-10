export const VAULT_DATA_RUNTIME_LAYOUT = [
  { directory: "workspaces", mountRoot: "/vault/workspaces" },
  { directory: "backups", mountRoot: "/vault/backups" },
  { directory: "cache", mountRoot: "/vault/cache" },
] as const;

export const VAULT_DATA_RUNTIME_ROOTS = VAULT_DATA_RUNTIME_LAYOUT.map(
  (entry) => entry.mountRoot,
) as ["/vault/workspaces", "/vault/backups", "/vault/cache"];

export const VAULT_DATA_PRIMARY_RUNTIME_ROOT = VAULT_DATA_RUNTIME_ROOTS[0];
