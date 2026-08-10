import { create } from "zustand";
import {
  ensureCurrentUser,
  isRequestError,
  logout,
  request,
  streamUrl,
  type PortalCredentialRecord,
  type PortalUserResponse,
} from "./portal-client.js";
import type { ShellHostSummary, ShellSession } from "@polaris/polaris-shell";

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

interface PortalStore extends PortalVaultState {
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
  connectLiveStream: (userId: string) => void;
  closeLiveStream: () => void;
  createHost: (input: { hostName: string; line: string; createDefaultProject: boolean }) => Promise<ShellHostSummary | null>;
  hostAction: (name: string, action: "start" | "stop") => Promise<void>;
  deleteHost: (name: string) => Promise<void>;
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

function parseEvent(event: Event): PortalVaultStreamEvent | null {
  try {
    const data = (event as MessageEvent<string>).data;
    return data ? JSON.parse(data) as PortalVaultStreamEvent : null;
  } catch {
    return null;
  }
}

export const usePortalStore = create<PortalStore>((set, get) => ({
  ...emptyState,
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
          set({ session: null, bootstrapped: true, loading: false });
          return;
        }
        throw error;
      }
      if (!session.authenticated) {
        set({ session: null, bootstrapped: true, loading: false });
        return;
      }
      if (!session.polarisUserId) {
        await ensureCurrentUser(session);
        session = await request<ShellSession>("/session");
      }
      set({ session, bootstrapped: true });
      if (session.polarisUserId) {
        await get().refreshHosts();
        get().connectLiveStream(session.polarisUserId);
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

  loadUser: async () => set({ user: await request<PortalUserResponse>("/polaris-user") }),
  readCredential: (userId, credentialId) => request<PortalCredentialRecord>(
    `/users/${encodeURIComponent(userId)}/credentials/${encodeURIComponent(credentialId)}`,
  ),
  clearError: () => set({ error: null }),
  signOut: async () => {
    get().closeLiveStream();
    set({ ...emptyState, session: null, user: null, bootstrapped: true });
    await logout();
  },
}));
