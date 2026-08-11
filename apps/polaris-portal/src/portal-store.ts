import { create } from "zustand";
import {
  ensureCurrentUser,
  domainPacks,
  isRequestError,
  logout,
  request,
  streamUrl,
  type PortalCredentialRecord,
  type PortalUserResponse,
} from "./portal-client.js";
import type { ShellHostSummary, ShellSession } from "@polaris/polaris-shell";
import {
  createInitialWorkflowState,
  createMockRunsForCatalog,
  cardsFromRuns,
  updateCardFromRun,
  workflowKey,
  type MockWorkflowArtifact,
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
  refreshDomainPacks: () => Promise<void>;
  connectLiveStream: (userId: string) => void;
  closeLiveStream: () => void;
  createHost: (input: { hostName: string; line: string; createDefaultProject: boolean }) => Promise<ShellHostSummary | null>;
  hostAction: (name: string, action: "start" | "stop") => Promise<void>;
  deleteHost: (name: string) => Promise<void>;
  startWorkflowRun: (input: {
    packId: string;
    flowId: string;
    vaultId: string;
    values: Record<string, string>;
  }) => Promise<MockWorkflowRun>;
  approveWorkflowRun: (runId: string) => Promise<void>;
  cancelWorkflowRun: (runId: string) => Promise<void>;
  retryWorkflowRun: (runId: string) => Promise<MockWorkflowRun | null>;
  completeProvisioning: (input: {
    domainPackId: string;
    vaultId: string;
    enabledWorkflowKeys: string[];
  }) => Promise<void>;
  toggleWorkflow: (packId: string, flowId: string, enabled: boolean) => void;
  setWorkflowDefaultVault: (vaultId: string) => void;
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
const initialWorkflowState = createInitialWorkflowState();
const workflowTimers = new Map<string, ReturnType<typeof setTimeout>>();
let workflowIdSequence = 0;

function nextWorkflowId(prefix: string): string {
  workflowIdSequence += 1;
  return `${prefix}-${Date.now()}-${workflowIdSequence}`;
}

function releaseWorkflowTimer(runId: string): void {
  const timer = workflowTimers.get(runId);
  if (timer) clearTimeout(timer);
  workflowTimers.delete(runId);
}

function scheduleWorkflowTimer(runId: string, callback: () => void, delay: number): void {
  releaseWorkflowTimer(runId);
  const timer = setTimeout(() => {
    workflowTimers.delete(runId);
    callback();
  }, delay);
  workflowTimers.set(runId, timer);
}

function mockArtifact(run: MockWorkflowRun): MockWorkflowArtifact {
  return {
    id: `artifact-${run.id}`,
    name: `${run.flowId}-result.md`,
    kind: "report",
    size: "12 KB",
    summary: "由 mock executor 生成的结果摘要",
    content: `# ${run.title}\n\n这是 Portal 第一阶段的 synthetic artifact。\n\n运行：${run.id}\nVault：${run.vaultName}`,
  };
}

function mockEvent(
  run: MockWorkflowRun,
  title: string,
  detail: string,
  tone: "neutral" | "accent" | "warning" | "success",
): MockWorkflowRun["events"][number] {
  return {
    id: nextWorkflowId(`evt-${run.id}`),
    title,
    detail,
    timestamp: new Date().toISOString(),
    tone,
  };
}

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
  ...initialWorkflowState,
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
        await Promise.all([get().refreshHosts(), get().refreshDomainPacks()]);
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

  refreshDomainPacks: async () => {
    const payload = await domainPacks();
    const availablePackIds = new Set(payload.packs.map((pack) => pack.id));
    const availableWorkflowKeys = new Set(
      payload.packs.flatMap((pack) => pack.flows.map((flow) => workflowKey(pack.id, flow.id))),
    );
    set((state) => {
      const currentRuns = Object.values(state.runs);
      const runs = currentRuns.length > 0
        ? currentRuns
        : createMockRunsForCatalog(payload.packs, state.vaults);
      return {
        packs: payload.packs,
        runs: Object.fromEntries(runs.map((run) => [run.id, run])),
        cards: cardsFromRuns(runs),
        setup: {
          ...state.setup,
          domainPackId: state.setup.domainPackId && availablePackIds.has(state.setup.domainPackId)
            ? state.setup.domainPackId
            : null,
          enabledWorkflowKeys: state.setup.enabledWorkflowKeys.filter((key) => availableWorkflowKeys.has(key)),
        },
        error: null,
      };
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

  startWorkflowRun: async ({ packId, flowId, vaultId, values }) => {
    const pack = get().packs.find((item) => item.id === packId);
    const flow = pack?.flows.find((item) => item.id === flowId);
    const vault = get().vaults.find((item) => item.id === vaultId);
    if (!pack || !flow || !vault) throw new Error("工作流、流程或 Vault 不存在");
    if (vault.status === "starting") throw new Error("目标 Vault 正在准备中");

    const now = new Date().toISOString();
    const runId = nextWorkflowId("run");
    const run: MockWorkflowRun = {
      id: runId,
      packId,
      flowId,
      vaultId,
      vaultName: vault.name,
      status: "queued",
      priority: "normal",
      title: flow.title,
      summary: flow.summary,
      input: values,
      progress: 0,
      createdAt: now,
      updatedAt: now,
      approvalRequired: flow.approvalRequired,
      events: [mockEvent(
        {
          id: runId,
          packId,
          flowId,
          vaultId,
          vaultName: vault.name,
          status: "queued",
          priority: "normal",
          title: flow.title,
          summary: flow.summary,
          input: values,
          progress: 0,
          createdAt: now,
          updatedAt: now,
          approvalRequired: flow.approvalRequired,
          events: [],
          artifacts: [],
        },
        "已提交到执行队列",
        `将使用 ${pack.title}@${pack.version} · ${vault.name}`,
        "neutral",
      )],
      artifacts: [],
    };
    set((state) => ({
      runs: { ...state.runs, [run.id]: run },
      cards: [
        {
          id: `card-${run.id}`,
          runId: run.id,
          title: run.title,
          summary: run.summary,
          packId: run.packId,
          flowId: run.flowId,
          vaultName: run.vaultName,
          status: run.status,
          priority: run.priority,
          updatedAt: run.updatedAt,
        },
        ...state.cards,
      ],
      error: null,
    }));

    scheduleWorkflowTimer(run.id, () => {
      set((state) => {
        const current = state.runs[run.id];
        if (!current || current.status !== "queued") return state;
        const next = {
          ...current,
          status: "running" as const,
          progress: 28,
          updatedAt: new Date().toISOString(),
          events: [
            mockEvent(current, "已在 Vault 中开始运行", `已锁定 ${pack.title}@${pack.version}。`, "accent"),
            ...current.events,
          ],
        };
        return { runs: { ...state.runs, [run.id]: next }, cards: updateCardFromRun(state.cards, next) };
      });
      scheduleWorkflowTimer(run.id, () => {
        set((state) => {
          const current = state.runs[run.id];
          if (!current || current.status !== "running") return state;
          const waiting = current.approvalRequired;
          const next = {
            ...current,
            status: waiting ? "waiting" as const : "succeeded" as const,
            progress: waiting ? 76 : 100,
            updatedAt: new Date().toISOString(),
            events: [
              mockEvent(
                current,
                waiting ? "等待人工确认" : "运行完成",
                waiting ? "结果已准备好，请确认后继续生成最终产物。" : "已生成 synthetic artifact。",
                waiting ? "warning" : "success",
              ),
              ...current.events,
            ],
            artifacts: waiting ? current.artifacts : [mockArtifact(current)],
          };
          return { runs: { ...state.runs, [run.id]: next }, cards: updateCardFromRun(state.cards, next) };
        });
      }, 900);
    }, 350);
    return run;
  },

  approveWorkflowRun: async (runId) => {
    const run = get().runs[runId];
    if (!run || run.status !== "waiting") return;
    releaseWorkflowTimer(runId);
    const next = {
      ...run,
      status: "running" as const,
      progress: 88,
      updatedAt: new Date().toISOString(),
      events: [mockEvent(run, "已批准继续运行", "当前用户确认了下一步产出。", "accent"), ...run.events],
    };
    set((state) => ({ runs: { ...state.runs, [runId]: next }, cards: updateCardFromRun(state.cards, next) }));
    scheduleWorkflowTimer(runId, () => {
      set((state) => {
        const current = state.runs[runId];
        if (!current || current.status !== "running") return state;
        const completed = {
          ...current,
          status: "succeeded" as const,
          progress: 100,
          updatedAt: new Date().toISOString(),
          events: [mockEvent(current, "最终产物已生成", "运行完成，可以打开 artifact。", "success"), ...current.events],
          artifacts: [mockArtifact(current)],
        };
        return { runs: { ...state.runs, [runId]: completed }, cards: updateCardFromRun(state.cards, completed) };
      });
    }, 750);
  },

  cancelWorkflowRun: async (runId) => {
    const run = get().runs[runId];
    if (!run || !["queued", "running", "waiting"].includes(run.status)) return;
    releaseWorkflowTimer(runId);
    const next = {
      ...run,
      status: "cancelled" as const,
      updatedAt: new Date().toISOString(),
      events: [mockEvent(run, "运行已取消", "没有新的执行动作会被提交。", "warning"), ...run.events],
    };
    set((state) => ({ runs: { ...state.runs, [runId]: next }, cards: updateCardFromRun(state.cards, next) }));
  },

  retryWorkflowRun: async (runId) => {
    const run = get().runs[runId];
    if (!run || !["failed", "cancelled"].includes(run.status)) return null;
    const retry = await get().startWorkflowRun({
      packId: run.packId,
      flowId: run.flowId,
      vaultId: run.vaultId,
      values: run.input,
    });
    set((state) => ({
      cards: state.cards.map((card) => card.runId === runId ? { ...card, status: "cancelled" } : card),
    }));
    return retry;
  },

  completeProvisioning: async ({ domainPackId, vaultId, enabledWorkflowKeys }) => {
    set((state) => ({
      setup: {
        completed: true,
        domainPackId,
        vaultId,
        enabledWorkflowKeys,
        completedAt: new Date().toISOString(),
      },
    }));
  },

  toggleWorkflow: (packId, flowId, enabled) => {
    const key = workflowKey(packId, flowId);
    set((state) => ({
      setup: {
        ...state.setup,
        enabledWorkflowKeys: enabled
          ? [...new Set([...state.setup.enabledWorkflowKeys, key])]
          : state.setup.enabledWorkflowKeys.filter((currentKey) => currentKey !== key),
      },
    }));
  },

  setWorkflowDefaultVault: (vaultId) => {
    set((state) => ({ setup: { ...state.setup, vaultId } }));
  },

  loadUser: async () => set({ user: await request<PortalUserResponse>("/polaris-user") }),
  readCredential: (userId, credentialId) => request<PortalCredentialRecord>(
    `/users/${encodeURIComponent(userId)}/credentials/${encodeURIComponent(credentialId)}`,
  ),
  clearError: () => set({ error: null }),
  signOut: async () => {
    get().closeLiveStream();
    set({ ...emptyState, ...createInitialWorkflowState(), session: null, user: null, bootstrapped: true });
    await logout();
  },
}));
