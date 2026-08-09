import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ConcurrentUserCapacityOptions,
  ConcurrentUserCapacityResult,
} from "./concurrent-user-capacity.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "../..");
const TSX_CLI = path.join(PACKAGE_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const WORKER_PATH = path.join(SCRIPT_DIR, "concurrent-user-capacity.ts");
const WORKER_ENV = "POLARIS_CONCURRENT_USER_CAPACITY_BENCHMARK_WORKER";

class ConcurrentCapacityRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentCapacityRunnerError";
  }
}

type CliOptions = ConcurrentUserCapacityOptions & { output?: string };

function positiveInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConcurrentCapacityRunnerError(`${label} must be a positive integer`);
  }
  return value;
}

function workerArguments(options: ConcurrentUserCapacityOptions, outputPath: string): string[] {
  const args = [TSX_CLI, WORKER_PATH];
  const users = positiveInteger(options.users, "users");
  const rounds = positiveInteger(options.rounds, "rounds");
  const warmupRounds = positiveInteger(options.warmupRounds, "warmupRounds");
  if (users !== undefined) args.push("--users", String(users));
  if (rounds !== undefined) args.push("--rounds", String(rounds));
  if (warmupRounds !== undefined) args.push("--warmup-rounds", String(warmupRounds));
  args.push("--output", outputPath);
  return args;
}

function childFailureDetail(stdout: string, stderr: string): string {
  const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  return detail ? `\n${detail.slice(-8_000)}` : "";
}

async function runWorker(
  options: ConcurrentUserCapacityOptions,
  runRoot: string,
): Promise<ConcurrentUserCapacityResult> {
  if (!fs.existsSync(TSX_CLI)) {
    throw new ConcurrentCapacityRunnerError(`tsx CLI is unavailable at ${TSX_CLI}`);
  }
  const dataRoot = path.join(runRoot, "data");
  const resultPath = path.join(runRoot, "result.json");
  fs.mkdirSync(dataRoot, { recursive: true });
  const args = workerArguments(options, resultPath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        POLARIS_DATA_ROOT: dataRoot,
        [WORKER_ENV]: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 || code === 2) {
        resolve();
        return;
      }
      reject(new ConcurrentCapacityRunnerError(
        `Concurrent capacity worker failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}`
          + childFailureDetail(
            Buffer.concat(stdout).toString("utf8"),
            Buffer.concat(stderr).toString("utf8"),
          ),
      ));
    });
  });
  try {
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as ConcurrentUserCapacityResult;
    if (result.kind !== "polaris-concurrent-user-capacity-benchmark") {
      throw new ConcurrentCapacityRunnerError("Concurrent capacity worker wrote an invalid result");
    }
    return result;
  } catch (error) {
    if (error instanceof ConcurrentCapacityRunnerError) throw error;
    throw new ConcurrentCapacityRunnerError(
      `Concurrent capacity worker did not write a readable result: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Runs the concurrent multi-user capacity benchmark in a disposable child
 * process so it cannot use the caller's Polaris data root.
 */
function benchmarkTempRoot(): string {
  const configured = String(process.env.POLARIS_BENCHMARK_TMPDIR ?? "").trim();
  if (configured) {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  }
  // Prefer a workspace temp root over /tmp: concurrent multi-user fixtures
  // create many small files and fill a small tmpfs quickly.
  const workspaceTmp = path.resolve(PACKAGE_ROOT, "../../.tmp/polaris-bench");
  fs.mkdirSync(workspaceTmp, { recursive: true });
  return workspaceTmp;
}

export async function runConcurrentUserCapacityBenchmark(
  options: ConcurrentUserCapacityOptions = {},
): Promise<ConcurrentUserCapacityResult> {
  const runRoot = fs.mkdtempSync(path.join(benchmarkTempRoot(), "polaris-concurrent-capacity-"));
  try {
    return await runWorker(options, runRoot);
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

function parseArgument(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConcurrentCapacityRunnerError(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new ConcurrentCapacityRunnerError(`${flag} requires a value`);
    }
    index += 1;
    if (flag === "--users") options.users = parseArgument(value, "--users");
    else if (flag === "--rounds") options.rounds = parseArgument(value, "--rounds");
    else if (flag === "--warmup-rounds") options.warmupRounds = parseArgument(value, "--warmup-rounds");
    else if (flag === "--output") options.output = value;
    else throw new ConcurrentCapacityRunnerError(`Unsupported argument: ${flag}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const result = await runConcurrentUserCapacityBenchmark(options);
  const payload = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(options.output, payload, "utf8");
  }
  process.stdout.write(payload);
  if (!result.passed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
