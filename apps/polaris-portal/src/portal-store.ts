import { create } from "zustand";
import {
  createWorkflowRun,
  deleteWorkflowRun,
  domainPacks,
  ensureCurrentUser,
  isRequestError,
  logout,
  request,
  saveWorkflowSetup,
  streamUrl,
  workflowRunAction,
  workflowRuns,
  workflowSetup,
  workflowVaults,
  type PortalCredentialRecord,
  type PortalUserResponse,
} from "./portal-client.js";
import type {
  ShellHostSummary,
  ShellSession,
  WorkflowMockScenario,
  WorkflowSetupRequest,
} from "@polaris/polaris-shell";
import {
  createInitialWorkflowState,
  cardsFromRuns,
  workflowKey,
  workflowKeysForPack,
  type MockWorkflowRun,
  type WorkflowMockState,
} from "./workflow-mocks.js";

export interface PortalVaultStaticSummary {
  name: string;
  availableDrivers: Array<Record<string, unknown>>;
}

export interface PortalVaultLiveSummary {
  name: string;
  status: ShellHostSummary["status"] | null;
}

export type PortalVaultStreamEvent =
  | { type: "snapshot"; staticVaults: PortalVaultStaticSummary[]; liveVaults: PortalVaultLiveSummary[] }
  | { type: "static-upsert"; vault: PortalVaultStaticSummary }
  | { type: "static-remove"; vault: string }
  | { type: "live-upsert"; vault: PortalVaultLiveSummary }
  | { type: "live-remove"; vault: string }
  | { type: "heartbeat"; ts: number };

export interface PortalVaultState {
  hostsByName: Record<string, ShellHostSummary>;
  staticByName: Record<string, PortalVaultStaticSummary>;
  liveByName: Record<string, PortalVaultLiveSummary>;
}

const emptyState: PortalVaultState = { hostsByName: {}, staticByName: {}, liveByName: {} };

function objectByName<T extends { name: string }>(values: T[]): Record<string, T> {
  return Object.fromEntries(values.map((value) => [value.name, value]));
}

function placeholderHost(name: string, status: ShellHostSummary["status"]): ShellHostSummary {
  return { name, serverId: null, wanghaiId: null, surfaces: [], status };
}

function hostsWithLive(
  hosts: Record<string, ShellHostSummary>,
  liveByName: Record<string, PortalVaultLiveSummary>,
): Record<string, ShellHostSummary> {
  const next = { ...hosts };
  for (const live of Object.values(liveByName)) {
    const host = next[live.name] || placeholderHost(live.name, live.status);
    next[live.name] = { ...host, status: live.status };
  }
  return next;
}

export function applyVaultStreamEvent(state: PortalVaultState, event: PortalVaultStreamEvent): PortalVaultState {
  switch (event.type) {
    case "snapshot": {
      const staticByName = objectByName(event.staticVaults);
      const liveByName = objectByName(event.liveVaults);
      const hostsByName: Record<string, ShellHostSummary> = {};
      for (const name of Object.keys(staticByName)) {
        hostsByName[name] = state.hostsByName[name] || placeholderHost(name, liveByName[name]?.status || null);
      }
      return { staticByName, liveByName, hostsByName: hostsWithLive(hostsByName, liveByName) };
    }
    case "static-upsert": {
      const staticByName = { ...state.staticByName, [event.vault.name]: event.vault };
      const hostsByName = {
        ...state.hostsByName,
        [event.vault.name]: state.hostsByName[event.vault.name]
          || placeholderHost(event.vault.name, state.liveByName[event.vault.name]?.status || null),
      };
      return { ...state, staticByName, hostsByName };
    }
    case "static-remove": {
      const staticByName = { ...state.staticByName };
      const liveByName = { ...state.liveByName };
      const hostsByName = { ...state.hostsByName };
      delete staticByName[event.vault];
      delete liveByName[event.vault];
      delete hostsByName[event.vault];
      return { staticByName, liveByName, hostsByName };
    }
    case "live-upsert": {
      const liveByName = { ...state.liveByName, [event.vault.name]: event.vault };
      return { ...state, liveByName, hostsByName: hostsWithLive(state.hostsByName, liveByName) };
    }
    case "live-remove": {
      const liveByName = { ...state.liveByName };
      const hostsByName = { ...state.hostsByName };
      delete liveByName[event.vault];
      if (hostsByName[event.vault]) hostsByName[event.vault] = { ...hostsByName[event.vault], status: null };
      return { ...state, liveByName, hostsByName };
    }
    case "heartbeat":
      return state;
  }
}

interface PortalStore extends PortalVaultState, WorkflowMockState {
  session: ShellSession | null;
  user: PortalUserResponse | null;
  bootstrapped: boolean;
  loading: boolean;
  error: string | null;
  streamStatus: "idle" | "connecting" | "connected" | "reconnecting";
  lastHeartbeatAt: number | null;
  pendingHosts: Record<string, boolean>;
  bootstrap: () => Promise<void>;
  refreshHosts: () => Promise<void>;
  refreshWorkflowVaults: () => Promise<void>;
  refreshDomainPacks: () => Promise<void>;
  refreshWorkflowSetup: () => Promise<void>;
  refreshWorkflowRuns: () => Promise<void>;
  connectLiveStream: (userId: string) => void;
  closeLiveStream: () => void;
  createHost: (input: { hostName: string; line: string; createDefaultProject: boolean }) => Promise<ShellHostSummary | null>;
  hostAction: (name: string, action: "start" | "stop") => Promise<void>;
  deleteHost: (name: string) => Promise<void>;
  startWorkflowRun: (input: {
    packId: string;
    flowId: string;
    vaultId?: string;
    driver?: "none" | "vault";
    values: Record<string, string>;
    scenario?: WorkflowMockScenario;
  }) => Promise<MockWorkflowRun>;
  approveWorkflowRun: (runId: string) => Promise<void>;
  cancelWorkflowRun: (runId: string) => Promise<void>;
  retryWorkflowRun: (runId: string) => Promise<MockWorkflowRun | null>;
  deleteWorkflowRun: (runId: string) => Promise<void>;
  completeProvisioning: (input: {
    domainPackId: string;
    vaultId?: string | null;
    enabledWorkflowKeys: string[];
  }) => Promise<void>;
  toggleWorkflow: (packId: string, flowId: string, enabled: boolean) => Promise<void>;
  setWorkflowDefaultVault: (vaultId: string) => Promise<void>;
  loadUser: () => Promise<void>;
  readCredential: (userId: string, credentialId: string) => Promise<PortalCredentialRecord>;
  clearError: () => void;
  signOut: () => Promise<void>;
}

let eventSource: EventSource | null = null;
let streamUserId: string | null = null;
let streamGeneration = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let workflowPollTimer: ReturnType<typeof setTimeout> | null = null;
let workflowPollGeneration = 0;
let setupWrite: Promise<unknown> = Promise.resolve();

function persistWorkflowSetup(input: WorkflowSetupRequest) {
  const write = setupWrite.then(() => saveWorkflowSetup(input));
  setupWrite = write.then(() => undefined, () => undefined);
  return write;
}

function parseEvent(event: Event): PortalVaultStreamEvent | null {
  try {
    const data = (event as MessageEvent<string>).data;
    return data ? JSON.parse(data) as PortalVaultStreamEvent : null;
  } catch {
    return null;
  }
}

function stopWorkflowPolling(): void {
  workflowPollGeneration += 1;
  if (workflowPollTimer) clearTimeout(workflowPollTimer);
  workflowPollTimer = null;
}

function startWorkflowPolling(): void {
  if (workflowPollTimer) return;
  const generation = ++workflowPollGeneration;
  const poll = async () => {
    workflowPollTimer = null;
    if (generation !== workflowPollGeneration || !usePortalStore.getState().session?.polarisUserId) return;
    try {
      await usePortalStore.getState().refreshWorkflowRuns();
    } catch {
      // The next poll retries without replacing a good projection with an error.
    }
    if (generation === workflowPollGeneration && usePortalStore.getState().session?.polarisUserId) {
      workflowPollTimer = setTimeout(() => void poll(), 750);
    }
  };
  workflowPollTimer = setTimeout(() => void poll(), 750);
}

export const usePortalStore = create<PortalStore>((set, get) => ({
  ...emptyState,
  ...createInitialWorkflowState(),
  session: null,
  user: null,
  bootstrapped: false,
  loading: false,
  error: null,
  streamStatus: "idle",
  lastHeartbeatAt: null,
  pendingHosts: {},

  bootstrap: async () => {
    set({ loading: true, error: null });
    try {
      let session: ShellSession;
      try {
        session = await request<ShellSession>("/session");
      } catch (error) {
        if (isRequestError(error) && (error.status === 401 || error.status === 403)) {
          get().closeLiveStream();
          stopWorkflowPolling();
          set({ session: null, bootstrapped: true, loading: false });
          return;
        }
        throw error;
      }
      if (!session.authenticated) {
        stopWorkflowPolling();
        set({ session: null, bootstrapped: true, loading: false });
        return;
      }
      if (!session.polarisUserId) {
        await ensureCurrentUser(session);
        session = await request<ShellSession>("/session");
      }
      set({ session, bootstrapped: true });
      if (session.polarisUserId) {
        // The work desk and host execution do not depend on a Vault. Load only
        // the critical Polaris projections here; Vault inventory and live
        // status are fetched lazily by the pages that need them.
        await get().refreshDomainPacks();
        await get().refreshWorkflowSetup();
        await get().refreshWorkflowRuns();
        startWorkflowPolling();
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), bootstrapped: true });
    } finally {
      set({ loading: false });
    }
  },

  refreshHosts: async () => {
    if (!get().session?.polarisUserId) return;
    const payload = await request<{ hosts: ShellHostSummary[] }>("/polaris-hosts");
    set((state) => ({ hostsByName: hostsWithLive(objectByName(payload.hosts), state.liveByName), error: null }));
  },

  refreshWorkflowVaults: async () => {
    const payload = await workflowVaults();
    set({ vaults: payload.vaults, error: null });
  },

  refreshDomainPacks: async () => {
    const payload = await domainPacks();
    const availablePackIds = new Set(payload.packs.map((pack) => pack.id));
    set((state) => ({
        packs: payload.packs,
        setup: {
          ...state.setup,
          domainPackId: state.setup.domainPackId && availablePackIds.has(state.setup.domainPackId)
            ? state.setup.domainPackId
            : null,
          enabledWorkflowKeys: workflowKeysForPack(
            payload.packs,
            state.setup.domainPackId && availablePackIds.has(state.setup.domainPackId)
              ? state.setup.domainPackId
              : null,
            state.setup.enabledWorkflowKeys,
          ),
        },
        error: null,
      }));
  },

  refreshWorkflowSetup: async () => {
    const setup = await workflowSetup();
    const packs = get().packs;
    const domainPackId = setup.domainPackId && packs.some((pack) => pack.id === setup.domainPackId)
      ? setup.domainPackId
      : null;
    set({
      setup: {
        ...setup,
        domainPackId,
        enabledWorkflowKeys: workflowKeysForPack(packs, domainPackId, setup.enabledWorkflowKeys),
      },
      error: null,
    });
  },

  refreshWorkflowRuns: async () => {
    const payload = await workflowRuns();
    set({
      runs: Object.fromEntries(payload.runs.map((run) => [run.id, run])),
      cards: cardsFromRuns(payload.runs),
      replayCursor: payload.replayCursor,
      error: null,
    });
  },

  connectLiveStream: (userId) => {
    if (!userId || (eventSource && streamUserId === userId)) return;
    get().closeLiveStream();
    streamUserId = userId;
    const generation = ++streamGeneration;
    set({ streamStatus: "connecting" });
    const source = new EventSource(streamUrl(userId), { withCredentials: true });
    eventSource = source;
    const types: PortalVaultStreamEvent["type"][] = ["snapshot", "static-upsert", "static-remove", "live-upsert", "live-remove", "heartbeat"];
    for (const type of types) {
      source.addEventListener(type, (event) => {
        if (generation !== streamGeneration) return;
        const parsed = parseEvent(event);
        if (!parsed) return;
        const next = applyVaultStreamEvent(get(), parsed);
        set({ ...next, streamStatus: "connected", ...(parsed.type === "heartbeat" ? { lastHeartbeatAt: parsed.ts } : {}) });
      });
    }
    source.onopen = () => {
      retryAttempt = 0;
      set({ streamStatus: "connected" });
    };
    source.onerror = () => {
      if (generation !== streamGeneration) return;
      source.close();
      eventSource = null;
      streamUserId = null;
      set({ streamStatus: "reconnecting" });
      const delay = Math.min(30_000, 500 * 2 ** retryAttempt++);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (get().session?.polarisUserId === userId) {
          void get().refreshHosts().catch(() => undefined);
          void get().refreshWorkflowVaults().catch(() => undefined);
          get().connectLiveStream(userId);
        }
      }, delay);
    };
  },

  closeLiveStream: () => {
    streamGeneration += 1;
    streamUserId = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    eventSource?.close();
    eventSource = null;
    set({ streamStatus: "idle" });
  },

  createHost: async ({ hostName, line, createDefaultProject }) => {
    await request("/polaris-hosts", { method: "POST", body: JSON.stringify({ hostName, line }) });
    if (!createDefaultProject) {
      await get().refreshHosts();
      return null;
    }
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await get().refreshHosts();
      const host = get().hostsByName[hostName];
      if (line === "vertical" ? host?.wanghaiId : host?.serverId) return host;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error("主机仍在准备中，请稍后刷新主机列表");
  },

  hostAction: async (name, action) => {
    set((state) => ({ pendingHosts: { ...state.pendingHosts, [name]: true }, error: null }));
    try {
      await request(`/polaris-hosts/${encodeURIComponent(name)}`, { method: "POST", body: JSON.stringify({ action }) });
      await get().refreshHosts();
    } finally {
      set((state) => ({ pendingHosts: { ...state.pendingHosts, [name]: false } }));
    }
  },

  deleteHost: async (name) => {
    set((state) => ({ pendingHosts: { ...state.pendingHosts, [name]: true }, error: null }));
    try {
      await request(`/polaris-hosts/${encodeURIComponent(name)}`, { method: "DELETE" });
      set((state) => {
        const hostsByName = { ...state.hostsByName };
        delete hostsByName[name];
        return { hostsByName };
      });
    } finally {
      set((state) => ({ pendingHosts: { ...state.pendingHosts, [name]: false } }));
    }
  },

  startWorkflowRun: async ({ packId, flowId, vaultId, driver, values, scenario }) => {
    const response = await createWorkflowRun({
      packId,
      flowId,
      ...(vaultId ? { vaultId } : {}),
      ...(driver ? { driver } : {}),
      values,
      ...(scenario ? { scenario } : {}),
    });
    await get().refreshWorkflowRuns();
    return response.run;
  },

  approveWorkflowRun: async (runId) => {
    await workflowRunAction(runId, "approve");
    await get().refreshWorkflowRuns();
  },

  cancelWorkflowRun: async (runId) => {
    await workflowRunAction(runId, "cancel");
    await get().refreshWorkflowRuns();
  },

  retryWorkflowRun: async (runId) => {
    const response = await workflowRunAction(runId, "retry");
    await get().refreshWorkflowRuns();
    return response.run;
  },

  deleteWorkflowRun: async (runId) => {
    await deleteWorkflowRun(runId);
    await get().refreshWorkflowRuns();
  },

  completeProvisioning: async ({ domainPackId, vaultId, enabledWorkflowKeys }) => {
    const normalizedWorkflowKeys = workflowKeysForPack(get().packs, domainPackId, enabledWorkflowKeys);
    const optimistic: WorkflowSetupRequest = {
      completed: true,
      domainPackId,
      vaultId: vaultId ?? null,
      enabledWorkflowKeys: normalizedWorkflowKeys,
      completedAt: new Date().toISOString(),
    };
    set({ setup: optimistic, error: null });
    try {
      const response = await persistWorkflowSetup(optimistic);
      set({ setup: response.setup });
      await get().refreshWorkflowRuns();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      try {
        set({ setup: await workflowSetup() });
      } catch {
        // Keep the server error visible if the reconciliation request also fails.
      }
      throw error;
    }
  },

  toggleWorkflow: async (packId, flowId, enabled) => {
    const key = workflowKey(packId, flowId);
    const current = get().setup;
    const nextDomainPackId = enabled ? packId : current.domainPackId;
    const nextEnabledWorkflowKeys = enabled
      ? [
          ...(current.domainPackId === packId
            ? current.enabledWorkflowKeys.filter((currentKey) => currentKey.startsWith(`${packId}:`))
            : []),
          key,
        ].filter((currentKey, index, keys) => keys.indexOf(currentKey) === index)
      : current.enabledWorkflowKeys.filter((currentKey) => currentKey !== key);
    const next: WorkflowSetupRequest = {
      ...current,
      completed: current.completed && nextEnabledWorkflowKeys.length > 0,
      domainPackId: nextDomainPackId,
      enabledWorkflowKeys: nextEnabledWorkflowKeys,
    };
    set({ setup: next, error: null });
    try {
      const response = await persistWorkflowSetup(next);
      set({ setup: response.setup });
      await get().refreshWorkflowRuns();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      try {
        set({ setup: await workflowSetup() });
      } catch {
        // Keep the server error visible if the reconciliation request also fails.
      }
    }
  },

  setWorkflowDefaultVault: async (vaultId) => {
    const current = get().setup;
    const next: WorkflowSetupRequest = { ...current, vaultId };
    set({ setup: next, error: null });
    if (!current.completed) return;
    try {
      const response = await persistWorkflowSetup(next);
      set({ setup: response.setup });
      await get().refreshWorkflowRuns();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      try {
        set({ setup: await workflowSetup() });
      } catch {
        // Keep the server error visible if the reconciliation request also fails.
      }
    }
  },

  loadUser: async () => set({ user: await request<PortalUserResponse>("/polaris-user") }),
  readCredential: (userId, credentialId) => request<PortalCredentialRecord>(
    `/users/${encodeURIComponent(userId)}/credentials/${encodeURIComponent(credentialId)}`,
  ),
  clearError: () => set({ error: null }),
  signOut: async () => {
    get().closeLiveStream();
    stopWorkflowPolling();
    setupWrite = Promise.resolve();
    set({ ...emptyState, ...createInitialWorkflowState(), session: null, user: null, bootstrapped: true });
    await logout();
  },
}));
