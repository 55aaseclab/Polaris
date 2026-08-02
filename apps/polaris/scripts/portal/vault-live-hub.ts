import fs, { type FSWatcher } from "node:fs";
import path from "node:path";
import {
  listPortalVaultLiveSummaries,
  listPortalVaultStaticSummaries,
  readPortalVaultLiveSummary,
  type PortalVaultLiveSummary,
  type PortalVaultStaticSummary,
  type PortalVaultStreamEvent,
} from "../core/portal.js";
import { polarisUsersRoot } from "../utils/paths.js";

const USER_ROOT = polarisUsersRoot(import.meta.url);
const WATCH_DEBOUNCE_MS = 100;
const HEARTBEAT_MS = 25_000;
const IDLE_TTL_MS = 30_000;

type VaultSubscriber = (event: PortalVaultStreamEvent) => void;

type VaultHub = {
  userId: string;
  subscribers: Set<VaultSubscriber>;
  staticByVault: Map<string, PortalVaultStaticSummary>;
  liveByVault: Map<string, PortalVaultLiveSummary>;
  inventoryWatcher: FSWatcher | null;
  vaultConfigWatchers: Map<string, FSWatcher>;
  vaultStateWatchers: Map<string, FSWatcher>;
  heartbeatTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  flushTimer: NodeJS.Timeout | null;
  dirtyInventory: boolean;
  dirtyLiveVaults: Set<string>;
};

const vaultHubs = new Map<string, VaultHub>();

function userVaultsRoot(userId: string): string {
  return path.join(USER_ROOT, userId, "vaults");
}

function vaultRoot(userId: string, vault: string): string {
  return path.join(userVaultsRoot(userId), vault);
}

function vaultStateRoot(userId: string, vault: string): string {
  return path.join(vaultRoot(userId, vault), "state");
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

function emitToSubscribers(hub: VaultHub, event: PortalVaultStreamEvent): void {
  for (const subscriber of hub.subscribers) {
    subscriber(event);
  }
}

function nextStaticMap(userId: string): Map<string, PortalVaultStaticSummary> {
  return new Map(
    listPortalVaultStaticSummaries(userId).map((vault) => [vault.name, vault] as const),
  );
}

function nextLiveMap(userId: string): Map<string, PortalVaultLiveSummary> {
  return new Map(
    listPortalVaultLiveSummaries(userId).map((vault) => [vault.name, vault] as const),
  );
}

function ensureUserVaultsRoot(userId: string): void {
  fs.mkdirSync(userVaultsRoot(userId), { recursive: true });
}

function scheduleFlush(hub: VaultHub): void {
  if (hub.flushTimer) {
    return;
  }
  hub.flushTimer = setTimeout(() => {
    hub.flushTimer = null;
    flushHub(hub);
  }, WATCH_DEBOUNCE_MS);
}

function markInventoryDirty(hub: VaultHub): void {
  hub.dirtyInventory = true;
  scheduleFlush(hub);
}

function markLiveDirty(hub: VaultHub, vault: string): void {
  hub.dirtyLiveVaults.add(vault);
  scheduleFlush(hub);
}

export function notifyPortalVaultLiveChange(userId: string, vault: string): void {
  const hub = vaultHubs.get(userId);
  if (!hub) {
    return;
  }
  const next = readPortalVaultLiveSummary(userId, vault);
  const previous = hub.liveByVault.get(vault);
  if (!previous || summaryStableString(previous) !== summaryStableString(next)) {
    hub.liveByVault.set(vault, next);
    emitToSubscribers(hub, { type: "live-upsert", vault: next });
    return;
  }
  markLiveDirty(hub, vault);
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

function syncVaultWatchers(hub: VaultHub, vaultNames: string[]): void {
  const nextVaultSet = new Set(vaultNames);

  for (const [vaultName, watcher] of hub.vaultConfigWatchers.entries()) {
    if (!nextVaultSet.has(vaultName)) {
      closeWatcher(watcher);
      hub.vaultConfigWatchers.delete(vaultName);
    }
  }
  for (const [vaultName, watcher] of hub.vaultStateWatchers.entries()) {
    if (!nextVaultSet.has(vaultName)) {
      closeWatcher(watcher);
      hub.vaultStateWatchers.delete(vaultName);
    }
  }

  for (const vaultName of vaultNames) {
    if (!hub.vaultConfigWatchers.has(vaultName)) {
      const watcher = createSafeWatcher(
        vaultRoot(hub.userId, vaultName),
        () => markInventoryDirty(hub),
      );
      if (watcher) {
        hub.vaultConfigWatchers.set(vaultName, watcher);
      }
    }
    if (!hub.vaultStateWatchers.has(vaultName)) {
      fs.mkdirSync(vaultStateRoot(hub.userId, vaultName), { recursive: true });
      const watcher = createSafeWatcher(
        vaultStateRoot(hub.userId, vaultName),
        () => markLiveDirty(hub, vaultName),
      );
      if (watcher) {
        hub.vaultStateWatchers.set(vaultName, watcher);
      }
    }
  }
}

function flushHub(hub: VaultHub): void {
  if (hub.dirtyInventory) {
    hub.dirtyInventory = false;
    hub.dirtyLiveVaults.clear();
    const nextStatic = nextStaticMap(hub.userId);
    const nextLive = nextLiveMap(hub.userId);

    for (const [vaultName, previous] of hub.staticByVault.entries()) {
      if (!nextStatic.has(vaultName)) {
        emitToSubscribers(hub, { type: "static-remove", vault: vaultName });
      } else if (
        summaryStableString(previous) !== summaryStableString(nextStatic.get(vaultName))
      ) {
        emitToSubscribers(hub, {
          type: "static-upsert",
          vault: nextStatic.get(vaultName)!,
        });
      }
    }
    for (const [vaultName, next] of nextStatic.entries()) {
      if (!hub.staticByVault.has(vaultName)) {
        emitToSubscribers(hub, { type: "static-upsert", vault: next });
      }
    }

    for (const [vaultName, previous] of hub.liveByVault.entries()) {
      if (!nextLive.has(vaultName)) {
        emitToSubscribers(hub, { type: "live-remove", vault: vaultName });
      } else if (
        summaryStableString(previous) !== summaryStableString(nextLive.get(vaultName))
      ) {
        emitToSubscribers(hub, {
          type: "live-upsert",
          vault: nextLive.get(vaultName)!,
        });
      }
    }
    for (const [vaultName, next] of nextLive.entries()) {
      if (!hub.liveByVault.has(vaultName)) {
        emitToSubscribers(hub, { type: "live-upsert", vault: next });
      }
    }

    hub.staticByVault = nextStatic;
    hub.liveByVault = nextLive;
    syncVaultWatchers(hub, Array.from(nextStatic.keys()));
    return;
  }

  const dirtyVaults = Array.from(hub.dirtyLiveVaults);
  hub.dirtyLiveVaults.clear();
  if (dirtyVaults.length === 0) {
    return;
  }
  const nextLive = nextLiveMap(hub.userId);
  for (const vaultName of dirtyVaults) {
    const previous = hub.liveByVault.get(vaultName);
    const next = nextLive.get(vaultName);
    if (!next) {
      if (previous) {
        hub.liveByVault.delete(vaultName);
        emitToSubscribers(hub, { type: "live-remove", vault: vaultName });
      }
      continue;
    }
    if (!previous || summaryStableString(previous) !== summaryStableString(next)) {
      hub.liveByVault.set(vaultName, next);
      emitToSubscribers(hub, { type: "live-upsert", vault: next });
    }
  }
}

function scheduleIdleCleanup(hub: VaultHub): void {
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

function ensureHub(userId: string): VaultHub {
  const existing = vaultHubs.get(userId);
  if (existing) {
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
    }
    return existing;
  }
  ensureUserVaultsRoot(userId);
  const staticByVault = nextStaticMap(userId);
  const liveByVault = nextLiveMap(userId);
  const hub: VaultHub = {
    userId,
    subscribers: new Set(),
    staticByVault,
    liveByVault,
    inventoryWatcher: createSafeWatcher(userVaultsRoot(userId), () => markInventoryDirty(hub)),
    vaultConfigWatchers: new Map(),
    vaultStateWatchers: new Map(),
    heartbeatTimer: null,
    idleTimer: null,
    flushTimer: null,
    dirtyInventory: false,
    dirtyLiveVaults: new Set(),
  };
  syncVaultWatchers(hub, Array.from(staticByVault.keys()));
  hub.heartbeatTimer = setInterval(() => {
    if (hub.subscribers.size === 0) {
      return;
    }
    emitToSubscribers(hub, { type: "heartbeat", ts: Date.now() });
  }, HEARTBEAT_MS);
  vaultHubs.set(userId, hub);
  return hub;
}

function disposeHub(userId: string): void {
  const hub = vaultHubs.get(userId);
  if (!hub) {
    return;
  }
  closeWatcher(hub.inventoryWatcher);
  for (const watcher of hub.vaultConfigWatchers.values()) {
    closeWatcher(watcher);
  }
  for (const watcher of hub.vaultStateWatchers.values()) {
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
  vaultHubs.delete(userId);
}

export function subscribePortalVaultStream(
  userId: string,
  subscriber: VaultSubscriber,
): () => void {
  const hub = ensureHub(userId);
  hub.subscribers.add(subscriber);
  subscriber({
    type: "snapshot",
    staticVaults: Array.from(hub.staticByVault.values()),
    liveVaults: Array.from(hub.liveByVault.values()),
  });
  return () => {
    hub.subscribers.delete(subscriber);
    if (hub.subscribers.size === 0) {
      scheduleIdleCleanup(hub);
    }
  };
}
