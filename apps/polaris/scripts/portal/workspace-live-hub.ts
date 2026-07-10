import fs, { type FSWatcher } from "node:fs";
import path from "node:path";
import {
  listPortalWorkspaceLiveSummaries,
  listPortalWorkspaceStaticSummaries,
  readPortalWorkspaceLiveSummary,
  type PortalWorkspaceLiveSummary,
  type PortalWorkspaceStaticSummary,
  type PortalWorkspaceStreamEvent,
} from "../core/portal.js";
import { polarisUsersRoot } from "../utils/paths.js";

const USER_ROOT = polarisUsersRoot(import.meta.url);
const WATCH_DEBOUNCE_MS = 100;
const HEARTBEAT_MS = 25_000;
const IDLE_TTL_MS = 30_000;

type WorkspaceSubscriber = (event: PortalWorkspaceStreamEvent) => void;

type WorkspaceHub = {
  userId: string;
  subscribers: Set<WorkspaceSubscriber>;
  staticByWorkspace: Map<string, PortalWorkspaceStaticSummary>;
  liveByWorkspace: Map<string, PortalWorkspaceLiveSummary>;
  inventoryWatcher: FSWatcher | null;
  workspaceConfigWatchers: Map<string, FSWatcher>;
  workspaceStateWatchers: Map<string, FSWatcher>;
  heartbeatTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  flushTimer: NodeJS.Timeout | null;
  dirtyInventory: boolean;
  dirtyLiveWorkspaces: Set<string>;
};

const workspaceHubs = new Map<string, WorkspaceHub>();

function userWorkspacesRoot(userId: string): string {
  return path.join(USER_ROOT, userId, "workspaces");
}

function workspaceRoot(userId: string, workspace: string): string {
  return path.join(userWorkspacesRoot(userId), workspace);
}

function workspaceStateRoot(userId: string, workspace: string): string {
  return path.join(workspaceRoot(userId, workspace), "state");
}

function summaryStableString(value: unknown): string {
  return JSON.stringify(value);
}

function closeWatcher(watcher: FSWatcher | null): void {
  if (!watcher) {
    return;
  }
  try {
    watcher.close();
  } catch {
    // ignore watcher shutdown races
  }
}

function emitToSubscribers(hub: WorkspaceHub, event: PortalWorkspaceStreamEvent): void {
  for (const subscriber of hub.subscribers) {
    subscriber(event);
  }
}

function nextStaticMap(userId: string): Map<string, PortalWorkspaceStaticSummary> {
  return new Map(
    listPortalWorkspaceStaticSummaries(userId).map((workspace) => [workspace.name, workspace] as const),
  );
}

function nextLiveMap(userId: string): Map<string, PortalWorkspaceLiveSummary> {
  return new Map(
    listPortalWorkspaceLiveSummaries(userId).map((workspace) => [workspace.name, workspace] as const),
  );
}

function ensureUserWorkspacesRoot(userId: string): void {
  fs.mkdirSync(userWorkspacesRoot(userId), { recursive: true });
}

function scheduleFlush(hub: WorkspaceHub): void {
  if (hub.flushTimer) {
    return;
  }
  hub.flushTimer = setTimeout(() => {
    hub.flushTimer = null;
    flushHub(hub);
  }, WATCH_DEBOUNCE_MS);
}

function markInventoryDirty(hub: WorkspaceHub): void {
  hub.dirtyInventory = true;
  scheduleFlush(hub);
}

function markLiveDirty(hub: WorkspaceHub, workspace: string): void {
  hub.dirtyLiveWorkspaces.add(workspace);
  scheduleFlush(hub);
}

export function notifyPortalWorkspaceLiveChange(userId: string, workspace: string): void {
  const hub = workspaceHubs.get(userId);
  if (!hub) {
    return;
  }
  const next = readPortalWorkspaceLiveSummary(userId, workspace);
  const previous = hub.liveByWorkspace.get(workspace);
  if (!previous || summaryStableString(previous) !== summaryStableString(next)) {
    hub.liveByWorkspace.set(workspace, next);
    emitToSubscribers(hub, { type: "live-upsert", workspace: next });
    return;
  }
  markLiveDirty(hub, workspace);
}

function createSafeWatcher(
  watchPath: string,
  onChange: () => void,
): FSWatcher | null {
  try {
    return fs.watch(watchPath, () => {
      onChange();
    });
  } catch {
    return null;
  }
}

function syncWorkspaceWatchers(hub: WorkspaceHub, workspaceNames: string[]): void {
  const nextWorkspaceSet = new Set(workspaceNames);

  for (const [workspaceName, watcher] of hub.workspaceConfigWatchers.entries()) {
    if (!nextWorkspaceSet.has(workspaceName)) {
      closeWatcher(watcher);
      hub.workspaceConfigWatchers.delete(workspaceName);
    }
  }
  for (const [workspaceName, watcher] of hub.workspaceStateWatchers.entries()) {
    if (!nextWorkspaceSet.has(workspaceName)) {
      closeWatcher(watcher);
      hub.workspaceStateWatchers.delete(workspaceName);
    }
  }

  for (const workspaceName of workspaceNames) {
    if (!hub.workspaceConfigWatchers.has(workspaceName)) {
      const watcher = createSafeWatcher(
        workspaceRoot(hub.userId, workspaceName),
        () => markInventoryDirty(hub),
      );
      if (watcher) {
        hub.workspaceConfigWatchers.set(workspaceName, watcher);
      }
    }
    if (!hub.workspaceStateWatchers.has(workspaceName)) {
      fs.mkdirSync(workspaceStateRoot(hub.userId, workspaceName), { recursive: true });
      const watcher = createSafeWatcher(
        workspaceStateRoot(hub.userId, workspaceName),
        () => markLiveDirty(hub, workspaceName),
      );
      if (watcher) {
        hub.workspaceStateWatchers.set(workspaceName, watcher);
      }
    }
  }
}

function flushHub(hub: WorkspaceHub): void {
  if (hub.dirtyInventory) {
    hub.dirtyInventory = false;
    hub.dirtyLiveWorkspaces.clear();
    const nextStatic = nextStaticMap(hub.userId);
    const nextLive = nextLiveMap(hub.userId);

    for (const [workspaceName, previous] of hub.staticByWorkspace.entries()) {
      if (!nextStatic.has(workspaceName)) {
        emitToSubscribers(hub, { type: "static-remove", workspace: workspaceName });
      } else if (
        summaryStableString(previous) !== summaryStableString(nextStatic.get(workspaceName))
      ) {
        emitToSubscribers(hub, {
          type: "static-upsert",
          workspace: nextStatic.get(workspaceName)!,
        });
      }
    }
    for (const [workspaceName, next] of nextStatic.entries()) {
      if (!hub.staticByWorkspace.has(workspaceName)) {
        emitToSubscribers(hub, { type: "static-upsert", workspace: next });
      }
    }

    for (const [workspaceName, previous] of hub.liveByWorkspace.entries()) {
      if (!nextLive.has(workspaceName)) {
        emitToSubscribers(hub, { type: "live-remove", workspace: workspaceName });
      } else if (
        summaryStableString(previous) !== summaryStableString(nextLive.get(workspaceName))
      ) {
        emitToSubscribers(hub, {
          type: "live-upsert",
          workspace: nextLive.get(workspaceName)!,
        });
      }
    }
    for (const [workspaceName, next] of nextLive.entries()) {
      if (!hub.liveByWorkspace.has(workspaceName)) {
        emitToSubscribers(hub, { type: "live-upsert", workspace: next });
      }
    }

    hub.staticByWorkspace = nextStatic;
    hub.liveByWorkspace = nextLive;
    syncWorkspaceWatchers(hub, Array.from(nextStatic.keys()));
    return;
  }

  const dirtyWorkspaces = Array.from(hub.dirtyLiveWorkspaces);
  hub.dirtyLiveWorkspaces.clear();
  if (dirtyWorkspaces.length === 0) {
    return;
  }
  const nextLive = nextLiveMap(hub.userId);
  for (const workspaceName of dirtyWorkspaces) {
    const previous = hub.liveByWorkspace.get(workspaceName);
    const next = nextLive.get(workspaceName);
    if (!next) {
      if (previous) {
        hub.liveByWorkspace.delete(workspaceName);
        emitToSubscribers(hub, { type: "live-remove", workspace: workspaceName });
      }
      continue;
    }
    if (!previous || summaryStableString(previous) !== summaryStableString(next)) {
      hub.liveByWorkspace.set(workspaceName, next);
      emitToSubscribers(hub, { type: "live-upsert", workspace: next });
    }
  }
}

function scheduleIdleCleanup(hub: WorkspaceHub): void {
  if (hub.idleTimer) {
    clearTimeout(hub.idleTimer);
  }
  hub.idleTimer = setTimeout(() => {
    if (hub.subscribers.size > 0) {
      return;
    }
    disposeHub(hub.userId);
  }, IDLE_TTL_MS);
}

function ensureHub(userId: string): WorkspaceHub {
  const existing = workspaceHubs.get(userId);
  if (existing) {
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
    }
    return existing;
  }
  ensureUserWorkspacesRoot(userId);
  const staticByWorkspace = nextStaticMap(userId);
  const liveByWorkspace = nextLiveMap(userId);
  const hub: WorkspaceHub = {
    userId,
    subscribers: new Set(),
    staticByWorkspace,
    liveByWorkspace,
    inventoryWatcher: createSafeWatcher(userWorkspacesRoot(userId), () => markInventoryDirty(hub)),
    workspaceConfigWatchers: new Map(),
    workspaceStateWatchers: new Map(),
    heartbeatTimer: null,
    idleTimer: null,
    flushTimer: null,
    dirtyInventory: false,
    dirtyLiveWorkspaces: new Set(),
  };
  syncWorkspaceWatchers(hub, Array.from(staticByWorkspace.keys()));
  hub.heartbeatTimer = setInterval(() => {
    if (hub.subscribers.size === 0) {
      return;
    }
    emitToSubscribers(hub, { type: "heartbeat", ts: Date.now() });
  }, HEARTBEAT_MS);
  workspaceHubs.set(userId, hub);
  return hub;
}

function disposeHub(userId: string): void {
  const hub = workspaceHubs.get(userId);
  if (!hub) {
    return;
  }
  closeWatcher(hub.inventoryWatcher);
  for (const watcher of hub.workspaceConfigWatchers.values()) {
    closeWatcher(watcher);
  }
  for (const watcher of hub.workspaceStateWatchers.values()) {
    closeWatcher(watcher);
  }
  if (hub.heartbeatTimer) {
    clearInterval(hub.heartbeatTimer);
  }
  if (hub.idleTimer) {
    clearTimeout(hub.idleTimer);
  }
  if (hub.flushTimer) {
    clearTimeout(hub.flushTimer);
  }
  workspaceHubs.delete(userId);
}

export function subscribePortalWorkspaceStream(
  userId: string,
  subscriber: WorkspaceSubscriber,
): () => void {
  const hub = ensureHub(userId);
  hub.subscribers.add(subscriber);
  subscriber({
    type: "snapshot",
    staticWorkspaces: Array.from(hub.staticByWorkspace.values()),
    liveWorkspaces: Array.from(hub.liveByWorkspace.values()),
  });
  return () => {
    hub.subscribers.delete(subscriber);
    if (hub.subscribers.size === 0) {
      scheduleIdleCleanup(hub);
    }
  };
}
