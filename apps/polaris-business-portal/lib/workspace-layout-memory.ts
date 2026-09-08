export type WorkspaceShellSidebarTab = "assets" | "workflows" | "paseo";
export type WorkspaceShellContentSidebarTab = "assets" | "workflows";
export type WorkspaceShellLayoutGroup = "outer" | "workflow-sidebar";

export type WorkspaceShellLayoutPrefs = {
  leftSidebarTab: WorkspaceShellSidebarTab;
  lastContentSidebarTab: WorkspaceShellContentSidebarTab;
  rightPaseoOpen: boolean;
};

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;
export type WorkspaceShellStorage = StorageReader & StorageWriter;

const STORAGE_PREFIX = "wanghai.admin.workspace-shell";
const NOOP_STORAGE: WorkspaceShellStorage = {
  getItem() {
    return null;
  },
  setItem() {
    // SSR fallback: persist nothing until the browser takes over.
  },
};

const DEFAULT_LAYOUT_PREFS: WorkspaceShellLayoutPrefs = {
  leftSidebarTab: "workflows",
  lastContentSidebarTab: "workflows",
  rightPaseoOpen: false,
};

function normalizedWorkspaceId(workspace: string): string {
  const value = workspace.trim();
  return value || "default";
}

function prefsStorageKey(workspace: string): string {
  return `${STORAGE_PREFIX}:${normalizedWorkspaceId(workspace)}:prefs`;
}

function selectedWorkspaceStorageKey(): string {
  return `${STORAGE_PREFIX}:selected-workspace`;
}

function validSidebarTab(value: unknown): value is WorkspaceShellSidebarTab {
  return value === "assets" || value === "workflows" || value === "paseo";
}

function validContentSidebarTab(value: unknown): value is WorkspaceShellContentSidebarTab {
  return value === "assets" || value === "workflows";
}

export function defaultWorkspaceShellLayoutPrefs(): WorkspaceShellLayoutPrefs {
  return { ...DEFAULT_LAYOUT_PREFS };
}

export function workspaceShellLayoutGroupId(
  workspace: string,
  group: WorkspaceShellLayoutGroup,
): string {
  return `${STORAGE_PREFIX}:${normalizedWorkspaceId(workspace)}:${group}`;
}

export function workspaceShellLayoutMountKey(
  workspace: string,
  group: WorkspaceShellLayoutGroup,
  panelIds: readonly string[],
): string {
  return `${workspaceShellLayoutGroupId(workspace, group)}:${panelIds.join(",")}`;
}

export function workspaceShellStorage(): WorkspaceShellStorage {
  if (typeof window === "undefined") {
    return NOOP_STORAGE;
  }
  return window.localStorage;
}

export function readWorkspaceShellLayoutPrefs(
  workspace: string,
  storage: StorageReader,
): WorkspaceShellLayoutPrefs {
  try {
    const raw = storage.getItem(prefsStorageKey(workspace));
    if (!raw) return defaultWorkspaceShellLayoutPrefs();
    const parsed = JSON.parse(raw) as Partial<WorkspaceShellLayoutPrefs>;
    return {
      leftSidebarTab: validSidebarTab(parsed.leftSidebarTab)
        ? parsed.leftSidebarTab
        : DEFAULT_LAYOUT_PREFS.leftSidebarTab,
      lastContentSidebarTab: validContentSidebarTab(parsed.lastContentSidebarTab)
        ? parsed.lastContentSidebarTab
        : DEFAULT_LAYOUT_PREFS.lastContentSidebarTab,
      rightPaseoOpen: typeof parsed.rightPaseoOpen === "boolean"
        ? parsed.rightPaseoOpen
        : DEFAULT_LAYOUT_PREFS.rightPaseoOpen,
    };
  } catch {
    return defaultWorkspaceShellLayoutPrefs();
  }
}

export function writeWorkspaceShellLayoutPrefs(
  workspace: string,
  prefs: WorkspaceShellLayoutPrefs,
  storage: StorageWriter,
): void {
  try {
    storage.setItem(prefsStorageKey(workspace), JSON.stringify(prefs));
  } catch {
    // localStorage can be unavailable
  }
}

export function readSelectedWorkspace(
  storage: StorageReader,
): string | null {
  try {
    const value = storage.getItem(selectedWorkspaceStorageKey())?.trim() ?? "";
    return value || null;
  } catch {
    return null;
  }
}

export function writeSelectedWorkspace(
  workspace: string,
  storage: StorageWriter,
): void {
  try {
    const value = workspace.trim();
    if (!value) return;
    storage.setItem(selectedWorkspaceStorageKey(), value);
  } catch {
    // localStorage can be unavailable
  }
}

export function resolveInitialWorkspaceSelection(input: {
  availableWorkspaces: string[];
  requestedWorkspace?: string | null;
  storedWorkspace?: string | null;
}): string {
  const requestedWorkspace = input.requestedWorkspace?.trim() ?? "";
  if (requestedWorkspace && input.availableWorkspaces.includes(requestedWorkspace)) {
    return requestedWorkspace;
  }

  const storedWorkspace = input.storedWorkspace?.trim() ?? "";
  if (storedWorkspace && input.availableWorkspaces.includes(storedWorkspace)) {
    return storedWorkspace;
  }

  return input.availableWorkspaces[0] ?? "";
}
