import { createHash } from "node:crypto";
import type {
  WorkflowArtifact,
  WorkflowDomainPackProjection,
  WorkflowEvent,
  WorkflowEventTone,
  WorkflowMockScenario,
  WorkflowPriority,
  WorkflowRunProjection,
  WorkflowRunRequest,
  WorkflowRunsResponse,
  WorkflowEventsResponse,
  WorkflowStatus,
  WorkflowVaultProjection,
} from "@polaris/polaris-shell";
import type { PortalVaultSummary } from "../core/portal.js";

export class WorkflowMockError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "WorkflowMockError";
  }
}

export function projectWorkflowVault(summary: PortalVaultSummary): WorkflowVaultProjection {
  const rawStatus = summary.status?.driver?.status;
  const selected = summary.status?.driver?.selected;
  const canRun = rawStatus === "running" && Boolean(selected);
  const profile = selected
    ? `${selected.backend}${selected.profile ? ` / ${selected.profile}` : ""}`
    : "未选择运行时";
  const surfaceSummary = summary.surfaces.length > 0
    ? `表面：${summary.surfaces.join("、")}`
    : "尚未配置可用表面";
  const description = summary.status?.driver?.reason?.trim() || `Polaris Vault · ${surfaceSummary}`;
  const capacity = summary.status?.details?.capacity?.trim()
    || summary.status?.details?.activeWorkspaceQuota?.trim()
    || "由 Polaris admission 管理";
  const availabilityReason = canRun
    ? null
    : summary.status?.driver?.reason?.trim()
      || (!rawStatus ? "Vault 尚未报告运行状态" : !selected ? "Vault 尚未选择运行时" : "Vault 当前不可运行");
  return {
    id: summary.name,
    name: summary.name,
    description,
    kind: "existing",
    status: rawStatus ?? null,
    canRun,
    availabilityReason,
    profile,
    capacity,
    surfaces: [...summary.surfaces],
    serverId: summary.serverId,
    wanghaiId: summary.wanghaiId,
  };
}

export function projectWorkflowVaults(summaries: PortalVaultSummary[]): WorkflowVaultProjection[] {
  return summaries.map(projectWorkflowVault);
}

type WorkflowMockServiceOptions = {
  listPacks: () => WorkflowDomainPackProjection[];
  listVaults: (userId: string) => Promise<WorkflowVaultProjection[]>;
  now?: () => Date;
  startDelayMs?: number;
  completionDelayMs?: number;
};

type WorkflowRunRecord = {
  run: WorkflowRunProjection;
  scenario: WorkflowMockScenario;
  timer: NodeJS.Timeout | null;
};

const DEFAULT_START_DELAY_MS = 350;
const DEFAULT_COMPLETION_DELAY_MS = 900;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function safeInput(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [String(key), String(value)]),
  );
}

function packFlows(packs: WorkflowDomainPackProjection[]) {
  return packs.flatMap((pack) => pack.flows.map((flow) => ({ pack, flow })));
}

function artifactFor(run: WorkflowRunProjection): WorkflowArtifact {
  const content = `# ${run.title}\n\n这是由 Polaris Phase 1 mock executor 生成的 synthetic artifact。\n\n运行：${run.id}\nVault：${run.vaultName}`;
  return {
    id: `artifact-${run.id}`,
    name: `${run.flowId}-result.md`,
    kind: "report",
    size: "12 KB",
    summary: "mock executor 生成的结果摘要",
    content,
    digest: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    redacted: false,
  };
}

export class WorkflowMockService {
  private readonly users = new Map<string, Map<string, WorkflowRunRecord>>();
  private readonly cursors = new Map<string, number>();
  private runSequence = 0;
  private readonly now: () => Date;
  private readonly startDelayMs: number;
  private readonly completionDelayMs: number;

  constructor(private readonly options: WorkflowMockServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.startDelayMs = options.startDelayMs ?? DEFAULT_START_DELAY_MS;
    this.completionDelayMs = options.completionDelayMs ?? DEFAULT_COMPLETION_DELAY_MS;
  }

  close(): void {
    for (const runs of this.users.values()) {
      for (const record of runs.values()) {
        if (record.timer) clearTimeout(record.timer);
      }
    }
    this.users.clear();
    this.cursors.clear();
  }

  async listRuns(userId: string): Promise<WorkflowRunsResponse> {
    const runs = await this.ensureUserRuns(userId);
    return {
      runs: [...runs.values()]
        .map((record) => clone(record.run))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      replayCursor: this.cursors.get(userId) ?? 0,
    };
  }

  async createRun(userId: string, input: WorkflowRunRequest): Promise<WorkflowRunProjection> {
    const pack = this.options.listPacks().find((candidate) => candidate.id === input.packId);
    const flow = pack?.flows.find((candidate) => candidate.id === input.flowId);
    if (!pack || !flow) {
      throw new WorkflowMockError("工作流或流程不存在", 404, "workflow-not-found");
    }
    const vaults = await this.options.listVaults(userId);
    const vault = vaults.find((candidate) => candidate.id === input.vaultId);
    if (!vault) {
      throw new WorkflowMockError("目标 Vault 不属于当前用户", 404, "vault-not-found");
    }
    const scenario = input.scenario ?? "normal";
    if (scenario === "quota-denied") {
      throw new WorkflowMockError("当前 Vault 的工作流配额已用尽", 429, "quota-denied");
    }
    if (scenario === "vault-unavailable" || !vault.canRun) {
      throw new WorkflowMockError("目标 Vault 当前不可用", 409, "vault-unavailable");
    }

    const now = this.now().toISOString();
    const run: WorkflowRunProjection = {
      id: `mock-run-${++this.runSequence}`,
      packId: pack.id,
      flowId: flow.id,
      packVersion: pack.version,
      packDigest: pack.digest,
      vaultId: vault.id,
      vaultName: vault.name,
      status: "queued",
      priority: "normal",
      title: flow.title,
      summary: flow.summary,
      input: safeInput(input.values),
      progress: 0,
      createdAt: now,
      updatedAt: now,
      approvalRequired: flow.approvalRequired,
      source: "manual",
      executionClass: "workspace",
      capabilityLeaseId: `mock-lease-${this.runSequence}`,
      capabilityLeaseExpiresAt: new Date(Date.parse(now) + 30 * 60_000).toISOString(),
      policy: {
        decision: "allow",
        mode: "mock",
        reasons: ["synthetic-fixture"],
      },
      events: [],
      receipts: [],
      artifacts: [],
    };
    const record: WorkflowRunRecord = { run, scenario, timer: null };
    this.userRuns(userId).set(run.id, record);
    this.appendEvent(userId, record, "submitted", "已提交到执行队列", `已绑定 ${pack.title}@${pack.version} · ${vault.name}`, "neutral");
    this.schedule(record, userId, this.startDelayMs, () => this.startRun(userId, record));
    return clone(run);
  }

  async approve(userId: string, runId: string): Promise<WorkflowRunProjection> {
    const record = this.requireRun(userId, runId);
    if (record.run.status !== "waiting") {
      throw new WorkflowMockError("当前运行不在等待确认状态", 409, "approval-not-available");
    }
    record.run.status = "running";
    record.run.progress = 88;
    record.run.updatedAt = this.now().toISOString();
    this.appendEvent(userId, record, "approved", "已批准继续运行", "当前用户确认了下一步产出。", "accent");
    this.schedule(record, userId, this.completionDelayMs, () => this.succeedRun(userId, record));
    return clone(record.run);
  }

  async cancel(userId: string, runId: string): Promise<WorkflowRunProjection> {
    const record = this.requireRun(userId, runId);
    if (!["queued", "running", "waiting"].includes(record.run.status)) {
      throw new WorkflowMockError("当前运行不可取消", 409, "cancel-not-available");
    }
    this.clearTimer(record);
    record.run.status = "cancelled";
    record.run.updatedAt = this.now().toISOString();
    this.appendEvent(userId, record, "cancelled", "运行已取消", "没有新的执行动作会被提交。", "warning");
    return clone(record.run);
  }

  async retry(
    userId: string,
    runId: string,
    scenario: WorkflowMockScenario = "normal",
  ): Promise<WorkflowRunProjection> {
    const record = this.requireRun(userId, runId);
    if (!["failed", "cancelled"].includes(record.run.status)) {
      throw new WorkflowMockError("只有失败或取消的运行可以重试", 409, "retry-not-available");
    }
    return this.createRun(userId, {
      packId: record.run.packId,
      flowId: record.run.flowId,
      vaultId: record.run.vaultId,
      values: record.run.input,
      scenario,
    });
  }

  async events(userId: string, runId: string, after = 0): Promise<WorkflowEventsResponse> {
    const record = this.requireRun(userId, runId);
    const cursor = Number.isFinite(after) && after >= 0 ? after : 0;
    return {
      runId,
      events: clone(record.run.events)
        .filter((event) => event.sequence > cursor)
        .sort((left, right) => left.sequence - right.sequence),
      nextCursor: this.cursors.get(userId) ?? 0,
    };
  }

  private userRuns(userId: string): Map<string, WorkflowRunRecord> {
    const existing = this.users.get(userId);
    if (existing) return existing;
    const created = new Map<string, WorkflowRunRecord>();
    this.users.set(userId, created);
    return created;
  }

  private async ensureUserRuns(userId: string): Promise<Map<string, WorkflowRunRecord>> {
    const runs = this.userRuns(userId);
    if (runs.size > 0) return runs;
    const packs = this.options.listPacks();
    const vaults = (await this.options.listVaults(userId)).filter((vault) => vault.canRun);
    const available = packFlows(packs)
      .sort((left, right) => Number(right.flow.approvalRequired) - Number(left.flow.approvalRequired))
      .slice(0, 3);
    for (const [index, item] of available.entries()) {
      const vault = vaults[index % vaults.length];
      if (!vault) break;
      const status: WorkflowStatus = index === 0 && item.flow.approvalRequired
        ? "waiting"
        : index === 1
          ? "running"
          : "succeeded";
      const now = this.now();
      const run: WorkflowRunProjection = {
        id: `mock-seed-${++this.runSequence}`,
        packId: item.pack.id,
        flowId: item.flow.id,
        packVersion: item.pack.version,
        packDigest: item.pack.digest,
        vaultId: vault.id,
        vaultName: vault.name,
        status,
        priority: index === 0 ? "urgent" : index === 1 ? "normal" : "low",
        title: item.flow.title,
        summary: item.flow.summary,
        input: Object.fromEntries(item.flow.fields.map((field) => [field.id, "示例输入"])),
        progress: status === "waiting" ? 76 : status === "running" ? 46 : 100,
        createdAt: new Date(now.getTime() - (index + 1) * 15 * 60 * 1000).toISOString(),
        updatedAt: now.toISOString(),
        approvalRequired: item.flow.approvalRequired,
        source: "manual",
        executionClass: "workspace",
        capabilityLeaseId: `mock-lease-${this.runSequence}`,
        capabilityLeaseExpiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
        policy: {
          decision: "allow",
          mode: "mock",
          reasons: ["synthetic-fixture"],
        },
        events: [],
        receipts: [],
        artifacts: [],
      };
      const record: WorkflowRunRecord = { run, scenario: "normal", timer: null };
      runs.set(run.id, record);
      this.appendEvent(userId, record, status, status === "waiting" ? "等待人工确认" : status === "running" ? "已在 Vault 中开始运行" : "结果已生成", "来自服务端 Phase 1 mock projection。", status === "waiting" ? "warning" : status === "running" ? "accent" : "success");
      if (status === "succeeded") {
        run.artifacts = [artifactFor(run)];
      }
    }
    return runs;
  }

  private requireRun(userId: string, runId: string): WorkflowRunRecord {
    const record = this.userRuns(userId).get(runId);
    if (!record) {
      throw new WorkflowMockError("运行不存在", 404, "run-not-found");
    }
    return record;
  }

  private appendEvent(
    userId: string,
    record: WorkflowRunRecord,
    kind: string,
    title: string,
    detail: string,
    tone: WorkflowEventTone,
  ): void {
    const sequence = (this.cursors.get(userId) ?? 0) + 1;
    this.cursors.set(userId, sequence);
    const event: WorkflowEvent = {
      id: `workflow-event-${sequence}`,
      sequence,
      kind,
      title,
      detail,
      timestamp: this.now().toISOString(),
      tone,
    };
    record.run.events = [event, ...record.run.events];
    record.run.updatedAt = event.timestamp;
  }

  private schedule(
    record: WorkflowRunRecord,
    userId: string,
    delay: number,
    callback: () => void,
  ): void {
    this.clearTimer(record);
    record.timer = setTimeout(() => {
      record.timer = null;
      callback();
    }, delay);
  }

  private clearTimer(record: WorkflowRunRecord): void {
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
  }

  private startRun(userId: string, record: WorkflowRunRecord): void {
    if (record.run.status !== "queued") return;
    record.run.status = "running";
    record.run.progress = 28;
    this.appendEvent(userId, record, "started", "已在 Vault 中开始运行", "mock executor 已获得一个执行位。", "accent");
    this.schedule(record, userId, this.completionDelayMs, () => this.finishRun(userId, record));
  }

  private finishRun(userId: string, record: WorkflowRunRecord): void {
    if (record.run.status !== "running") return;
    if (record.scenario === "executor-failure") {
      record.run.status = "failed";
      record.run.progress = 28;
      record.run.error = {
        code: "executor-failure",
        message: "mock executor 在 Vault 中报告了一个可重试错误。",
      };
      this.appendEvent(userId, record, "failed", "执行器失败", record.run.error.message, "warning");
      return;
    }
    if (record.run.approvalRequired) {
      record.run.status = "waiting";
      record.run.progress = 76;
      this.appendEvent(userId, record, "approval-required", "等待人工确认", "结果已准备好，请确认后继续生成最终产物。", "warning");
      return;
    }
    this.succeedRun(userId, record);
  }

  private succeedRun(userId: string, record: WorkflowRunRecord): void {
    if (record.run.status !== "running") return;
    record.run.status = "succeeded";
    record.run.progress = 100;
    record.run.error = undefined;
    record.run.artifacts = [artifactFor(record.run)];
    this.appendEvent(userId, record, "succeeded", "最终产物已生成", "运行完成，可以打开 artifact。", "success");
  }
}
