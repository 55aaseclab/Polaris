import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getWorkspacesDir } from "@polaris/business-core/repo";
import {
  isIntegratedBusinessRuntime,
  POLARIS_BUSINESS_RUNTIME_MODE_ENV,
} from "./business-runtime.js";

type JsonObject = Record<string, unknown>;

function findRepoRoot(): string {
  const envRoot = process.env.POLARIS_REPO_ROOT?.trim();
  if (envRoot && fs.existsSync(path.join(envRoot, "tools", "outreach", "clue-outreach"))) {
    return path.resolve(envRoot);
  }

  let current = path.resolve(process.cwd());
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(current, "tools", "outreach", "clue-outreach"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // apps/business-portal → monorepo root
  const fromApp = path.resolve(process.cwd(), "../..");
  if (fs.existsSync(path.join(fromApp, "tools", "outreach", "clue-outreach"))) {
    return fromApp;
  }
  throw new Error("Cannot locate tools/outreach/clue-outreach (set POLARIS_REPO_ROOT)");
}

function toolPath(): string {
  return path.join(findRepoRoot(), "tools", "outreach", "clue-outreach");
}

function requireWorkspacesRoot(): string {
  if (isIntegratedBusinessRuntime()) return getWorkspacesDir();

  const configured = process.env.POLARIS_BUSINESS_WORKSPACES_ROOT?.trim();
  if (configured) return path.resolve(configured);

  const dataRoot = process.env.POLARIS_BUSINESS_DATA_ROOT?.trim();
  if (dataRoot) return path.join(path.resolve(dataRoot), "workspaces");
  throw new Error(
    "POLARIS_BUSINESS_WORKSPACES_ROOT or POLARIS_BUSINESS_DATA_ROOT is required",
  );
}

function assertWorkspaceId(workspace: string): string {
  const value = workspace.trim();
  if (!value || path.basename(value) !== value || value === "." || value === "..") {
    throw new Error("Invalid workspace");
  }
  return value;
}

function runOutreach(args: string[]): JsonObject {
  const workspacesRoot = requireWorkspacesRoot();
  const binary = toolPath();
  let stdout: string;
  try {
    stdout = execFileSync(binary, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        POLARIS_BUSINESS_WORKSPACES_ROOT: workspacesRoot,
        [POLARIS_BUSINESS_RUNTIME_MODE_ENV]: isIntegratedBusinessRuntime()
          ? "polaris"
          : "standalone",
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
    });
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const fromStdout = typeof err.stdout === "string" ? parsedErrorMessage(err.stdout) : null;
    if (fromStdout) {
      throw new Error(fromStdout);
    }
    throw new Error(err.stderr?.trim() || err.message || "clue-outreach failed");
  }

  try {
    return JSON.parse(stdout) as JsonObject;
  } catch {
    throw new Error("clue-outreach returned non-JSON output");
  }
}

function parsedErrorMessage(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as JsonObject;
    return parsed.error ? String(parsed.error) : null;
  } catch {
    return null;
  }
}

export function getOutreachSnapshot(workspace: string): JsonObject {
  const id = assertWorkspaceId(workspace);
  const status = runOutreach(["status", "--workspace", id, "--tasks", "--limit", "100"]);
  const next = runOutreach(["next", "--workspace", id, "--limit", "100"]);
  let state: JsonObject | null = null;
  try {
    state = runOutreach(["show", "--workspace", id]);
  } catch {
    state = null;
  }
  return {
    source: {
      workspace: id,
      relative_path: "acquisition/customer-data-collection",
      tool: "clue-outreach",
    },
    status,
    tasks: Array.isArray(next.tasks) ? next.tasks : [],
    state,
  };
}

export type OutreachAction =
  | { action: "import" }
  | { action: "tick" }
  | { action: "approve"; engagement_id: string }
  | { action: "reject"; engagement_id: string; reason?: string }
  | { action: "send"; engagement_id: string; live?: boolean }
  | { action: "reply"; engagement_id: string; note?: string }
  | { action: "bounce"; engagement_id: string; soft?: boolean }
  | {
      action: "log";
      lead_id: string;
      channel: string;
      outcome: string;
      note?: string;
    }
  | { action: "suppress"; lead_id: string; reason: string }
  | { action: "customer"; lead_id: string }
  | {
      action: "draft";
      lead_id: string;
      channel?: string;
      intent?: string;
    };

export class WanghaiOutreachPolicyError extends Error {
  readonly statusCode = 503;

  constructor(message: string) {
    super(message);
    this.name = "WanghaiOutreachPolicyError";
  }
}

/**
 * A live SMTP send is a durable external side effect. In integrated mode,
 * Polaris must own its permission, idempotency key, outbox, and audit event.
 */
export function assertOutreachActionIsSurfaceOnly(
  action: OutreachAction,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    isIntegratedBusinessRuntime(env)
    && action.action === "send"
    && action.live === true
  ) {
    throw new WanghaiOutreachPolicyError(
      "Live outreach requires the Polaris durable action service",
    );
  }
}

export function runOutreachAction(
  workspace: string,
  body: OutreachAction,
  verifiedActor: string,
): JsonObject {
  assertOutreachActionIsSurfaceOnly(body);
  const id = assertWorkspaceId(workspace);
  const actor = verifiedActor.trim();
  if (!actor) {
    throw new Error("A verified gateway actor is required");
  }
  const actorArgs = ["--actor", actor];

  switch (body.action) {
    case "import":
      return runOutreach(["import", "--workspace", id, ...actorArgs]);
    case "tick":
      return runOutreach(["tick", "--workspace", id, ...actorArgs]);
    case "approve":
      return runOutreach([
        "approve",
        "--workspace",
        id,
        "--engagement-id",
        body.engagement_id,
        ...actorArgs,
      ]);
    case "reject":
      return runOutreach([
        "reject",
        "--workspace",
        id,
        "--engagement-id",
        body.engagement_id,
        ...(body.reason ? ["--reason", body.reason] : []),
        ...actorArgs,
      ]);
    case "send":
      return runOutreach([
        "send",
        "--workspace",
        id,
        "--engagement-id",
        body.engagement_id,
        ...(body.live ? ["--live"] : []),
        ...actorArgs,
      ]);
    case "reply":
      return runOutreach([
        "reply",
        "--workspace",
        id,
        "--engagement-id",
        body.engagement_id,
        ...(body.note ? ["--note", body.note] : []),
        ...actorArgs,
      ]);
    case "bounce":
      return runOutreach([
        "bounce",
        "--workspace",
        id,
        "--engagement-id",
        body.engagement_id,
        ...(body.soft ? ["--soft"] : []),
        ...actorArgs,
      ]);
    case "log":
      return runOutreach([
        "log",
        "--workspace",
        id,
        "--lead-id",
        body.lead_id,
        "--channel",
        body.channel,
        "--outcome",
        body.outcome,
        ...(body.note ? ["--note", body.note] : []),
        ...actorArgs,
      ]);
    case "suppress":
      return runOutreach([
        "suppress",
        "--workspace",
        id,
        "--lead-id",
        body.lead_id,
        "--reason",
        body.reason,
        ...actorArgs,
      ]);
    case "customer":
      return runOutreach([
        "customer",
        "--workspace",
        id,
        "--lead-id",
        body.lead_id,
        ...actorArgs,
      ]);
    case "draft":
      return runOutreach([
        "draft",
        "--workspace",
        id,
        "--lead-id",
        body.lead_id,
        "--channel",
        body.channel || "email",
        "--intent",
        body.intent || "first_touch",
        ...actorArgs,
      ]);
    default:
      throw new Error("Unsupported outreach action");
  }
}
