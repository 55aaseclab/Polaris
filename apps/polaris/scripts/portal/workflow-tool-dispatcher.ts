import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { repoRoot } from "../utils/paths.js";
import type {
  CtxValue,
  FfiInvokeRequest,
  FfiInvokeResult,
  PortAst,
  StepContext,
} from "polaris-workflow";
import type { WorkflowRunRecord } from "./control-store.js";

type DispatcherOptions = {
  importMetaUrl: string;
  environment: Record<string, string | undefined>;
};

type ToolInventory = {
  tools: Array<{ id: string; entrypoint: string; commands: string[] }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readInventory(importMetaUrl: string): ToolInventory {
  const file = path.join(repoRoot(importMetaUrl), "tools", "tool-inventory.json");
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.tools)) {
    throw new Error("tool inventory is invalid");
  }
  return {
    tools: parsed.tools.flatMap((item) => {
      if (!isRecord(item)
        || typeof item.id !== "string"
        || typeof item.entrypoint !== "string"
        || !Array.isArray(item.commands)) return [];
      return [{
        id: item.id,
        entrypoint: item.entrypoint,
        commands: item.commands.filter((command): command is string => typeof command === "string"),
      }];
    }),
  };
}

function safeRunId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error("workflow run id is unsafe");
  }
  return value;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function readJson(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isRecord(value)) throw new Error("tool output must be a JSON object");
  return value;
}

function stepOutput(value: Record<string, unknown>): FfiInvokeResult["output"] {
  const output: StepContext = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item === "object") {
      output[key] = JSON.stringify(item) ?? "";
    } else if (
      typeof item === "string"
      || typeof item === "number"
      || typeof item === "boolean"
      || item === undefined
    ) {
      output[key] = item as CtxValue;
    } else {
      output[key] = String(item);
    }
  }
  return output;
}

async function run(
  executable: string,
  args: string[],
  environment: Record<string, string | undefined>,
  cwd: string,
): Promise<void> {
  const child = spawn(executable, args, {
    cwd,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
  });
  const [status] = await once(child, "close") as [number | null];
  if (status !== 0) {
    const detail = stderr.trim() || "no stderr output";
    throw new Error(`${path.basename(executable)} failed with exit code ${status}: ${detail}`);
  }
}

function mapInput(
  input: Record<string, unknown>,
  aliases?: Record<string, string>,
): StepContext {
  const output: StepContext = {};
  for (const [key, value] of Object.entries(input)) {
    const mapped = aliases?.[key] ?? key;
    if (value === null || typeof value === "object") {
      output[mapped] = JSON.stringify(value) ?? "";
    } else if (
      typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
      || value === undefined
    ) {
      output[mapped] = value as CtxValue;
    } else {
      output[mapped] = String(value);
    }
  }
  return output;
}

export class WorkflowToolDispatcher {
  private readonly inventory: ToolInventory;

  constructor(
    private readonly runRecord: WorkflowRunRecord,
    private readonly ports: PortAst[],
    private readonly options: DispatcherOptions,
  ) {
    this.inventory = readInventory(options.importMetaUrl);
  }

  has(portName: string): boolean {
    const port = this.ports.find((candidate) => candidate.name === portName);
    return Boolean(port?.binding
      && this.inventory.tools.some((tool) =>
        tool.id === port.binding?.tool));
  }

  async invoke(req: FfiInvokeRequest, port: PortAst): Promise<FfiInvokeResult> {
    try {
      if (!port.binding) throw new Error(`port ${port.name} has no external binding`);
      const command = req.meta?.command || port.binding.command;
      if (!command) throw new Error(`port ${port.name} invocation has no command`);
      const tool = this.inventory.tools.find((candidate) =>
        candidate.id === port.binding?.tool);
      if (!tool) throw new Error(`tool ${port.binding.tool} is not in the inventory`);
      if (!tool.commands.includes(command)) {
        throw new Error(`tool ${tool.id} does not provide ${command}`);
      }
      const root = path.join(
        this.options.environment.POLARIS_WORKFLOW_WORKSPACES_ROOT
          || path.join(repoRoot(this.options.importMetaUrl), ".polaris", "workflow-workspaces"),
        safeRunId(this.runRecord.id),
      );
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const stem = port.name.replace(/[^A-Za-z0-9._-]/gu, "_");
      const inputPath = path.join(root, `${stem}.input.json`);
      const outputPath = path.join(root, `${stem}.output.json`);
      writeJson(inputPath, {
        runId: this.runRecord.id,
        tenantId: this.runRecord.tenantId,
        flowId: this.runRecord.flowId,
        stepId: req.meta?.stepId,
        outputFields: req.meta?.outputFields ?? [],
        workspaceRoot: root,
        input: mapInput(req.input, port.binding.aliases),
      });
      const executable = path.join(repoRoot(this.options.importMetaUrl), "tools", tool.entrypoint);
      await run(
        executable,
        ["workflow", command, "--input", inputPath, "--output", outputPath],
        this.options.environment,
        path.dirname(executable),
      );
      return {
        ok: true,
        output: stepOutput(readJson(outputPath)),
        resolvedVersion: port.version,
      };
    } catch (error) {
      return {
        ok: false,
        output: {},
        resolvedVersion: port.version,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
