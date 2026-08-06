import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  GatewayPerformanceBenchmarkOptions,
  GatewayPerformanceBenchmarkResult,
} from "./gateway-performance.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "../..");
const TSX_CLI = path.join(PACKAGE_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const WORKER_PATH = path.join(SCRIPT_DIR, "gateway-performance.ts");
const WORKER_ENV = "POLARIS_GATEWAY_PERFORMANCE_BENCHMARK_WORKER";

class GatewayBenchmarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayBenchmarkError";
  }
}

type CliOptions = GatewayPerformanceBenchmarkOptions & { output?: string };

function positiveInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new GatewayBenchmarkError(`${label} must be a positive integer`);
  }
  return value;
}

function workerArguments(options: GatewayPerformanceBenchmarkOptions, outputPath: string): string[] {
  const args = [TSX_CLI, WORKER_PATH];
  const samples = positiveInteger(options.samples, "samples");
  const vaults = positiveInteger(options.vaults, "vaults");
  const warmupSamples = positiveInteger(options.warmupSamples, "warmupSamples");
  if (samples !== undefined) args.push("--samples", String(samples));
  if (vaults !== undefined) args.push("--vaults", String(vaults));
  if (warmupSamples !== undefined) args.push("--warmup-samples", String(warmupSamples));
  if (options.profileDir) args.push("--profile-dir", path.resolve(options.profileDir));
  args.push("--output", outputPath);
  return args;
}

function childFailureDetail(stdout: string, stderr: string): string {
  const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  return detail ? `\n${detail.slice(-8_000)}` : "";
}

async function runWorker(
  options: GatewayPerformanceBenchmarkOptions,
  runRoot: string,
): Promise<GatewayPerformanceBenchmarkResult> {
  if (!fs.existsSync(TSX_CLI)) {
    throw new GatewayBenchmarkError(`tsx CLI is unavailable at ${TSX_CLI}`);
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
      if (code === 0) {
        resolve();
        return;
      }
      reject(new GatewayBenchmarkError(
        `Gateway benchmark worker failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}`
          + childFailureDetail(Buffer.concat(stdout).toString("utf8"), Buffer.concat(stderr).toString("utf8")),
      ));
    });
  });
  try {
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as GatewayPerformanceBenchmarkResult;
    if (result.kind !== "polaris-gateway-performance-benchmark") {
      throw new GatewayBenchmarkError("Gateway benchmark worker wrote an invalid result");
    }
    return result;
  } catch (error) {
    if (error instanceof GatewayBenchmarkError) throw error;
    throw new GatewayBenchmarkError(
      `Gateway benchmark worker did not write a readable result: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Runs the benchmark in a disposable child process so it cannot use the
 * caller's Polaris data root or leave synthetic tenants behind.
 */
export async function runGatewayPerformanceBenchmark(
  options: GatewayPerformanceBenchmarkOptions = {},
): Promise<GatewayPerformanceBenchmarkResult> {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-gateway-benchmark-"));
  try {
    return await runWorker(options, runRoot);
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

function parseArgument(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new GatewayBenchmarkError(`${label} must be a positive integer`);
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
      throw new GatewayBenchmarkError(`${flag} requires a value`);
    }
    index += 1;
    if (flag === "--samples") options.samples = parseArgument(value, "--samples");
    else if (flag === "--vaults") options.vaults = parseArgument(value, "--vaults");
    else if (flag === "--warmup-samples") options.warmupSamples = parseArgument(value, "--warmup-samples");
    else if (flag === "--profile-dir") options.profileDir = value;
    else if (flag === "--output") options.output = value;
    else throw new GatewayBenchmarkError(`Unsupported argument: ${flag}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const result = await runGatewayPerformanceBenchmark(options);
  const payload = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(options.output, payload, "utf8");
  }
  process.stdout.write(payload);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
