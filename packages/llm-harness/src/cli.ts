#!/usr/bin/env node
/**
 * `clh` CLI face. Subcommands:
 *   clh validate <preset.yaml>
 *   clh compile <preset.yaml> --context <@file.json|file.json|json> [--dry-run] [--workspace-root <dir>]
 *   clh run <preset.yaml> --context <file.json|json> [--workspace-root <dir>] [--timeout-ms <n>]
 *   clh call <preset.yaml> --prompt-file <f> [--system-file <f>] [--timeout-ms <n>]
 *
 * `--context` accepts `@file`, a bare existing file path, or inline JSON.
 * compile is inherently dry (it never spawns); `--dry-run` is accepted as
 * a no-op for symmetry with `run`.
 * Receipts print as JSON on stdout; failures print `code: message` on stderr
 * and exit non-zero.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { callApiPreset } from "./api-backend.js";
import { compilePreset } from "./compiler.js";
import { runDshPreset } from "./dsh-wrapper.js";
import { ClhError, isClhError } from "./errors.js";
import { readEnv } from "./env.js";
import { validatePreset } from "./schema.js";

interface CliArgs {
  positional: string[];
  flags: Map<string, string>;
}

const BOOLEAN_FLAGS = new Set(["dry-run"]);

export function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags.set(key, "true");
        continue;
      }
      // Value flags take the next token unless it is another flag; a
      // missing value stays empty and is handled by the command branch.
      const next = argv[i + 1];
      const value = next !== undefined && !next.startsWith("--") ? next : "";
      flags.set(key, value);
      if (value !== "") i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function loadPreset(presetPath: string): ReturnType<typeof validatePreset> {
  let raw: string;
  try {
    raw = readFileSync(presetPath, "utf8");
  } catch (error) {
    throw new ClhError("CLH_PRESET_INVALID", `Preset file is unreadable: ${presetPath}`, {
      cause: String(error),
    });
  }
  const parsed: unknown = parse(raw);
  return validatePreset(parsed);
}

export function loadContext(value: string | undefined): Record<string, string> {
  if (!value) return {};
  let raw: string;
  if (value.startsWith("@")) {
    raw = readFileSync(value.slice(1), "utf8");
  } else if (existsSync(value)) {
    raw = readFileSync(value, "utf8");
  } else if (value.trimStart().startsWith("{") || value.trimStart().startsWith("[")) {
    raw = value;
  } else {
    throw new ClhError(
      "CLH_PRESET_INVALID",
      `Context file not found and value is not inline JSON: ${value}`,
      {},
    );
  }
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ClhError("CLH_PRESET_INVALID", "Task context must be a JSON mapping", {});
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    result[key] = String(entry);
  }
  return result;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  if (command === "validate") {
    const presetPath = requirePositional(args, 0, "preset.yaml");
    const { preset, warnings } = loadPreset(presetPath);
    print({ ok: true, preset, warnings });
    return;
  }
  if (command === "compile") {
    const presetPath = requirePositional(args, 0, "preset.yaml");
    const { preset, warnings } = loadPreset(presetPath);
    const env = readEnv();
    const taskContext = loadContext(args.flags.get("context"));
    const presetDir = path.dirname(path.resolve(presetPath));
    const workspaceRoot = path.resolve(args.flags.get("workspace-root") ?? process.cwd());
    // compile never spawns; the compiled artifact is emitted for inspection.
    const compiled = await compilePreset({ preset, presetDir, taskContext, env, workspaceRoot });
    print({ ok: true, warnings, compiled });
    return;
  }
  if (command === "run") {
    const presetPath = requirePositional(args, 0, "preset.yaml");
    const { preset } = loadPreset(presetPath);
    const env = readEnv();
    const taskContext = loadContext(args.flags.get("context"));
    const presetDir = path.dirname(path.resolve(presetPath));
    const workspaceRoot = path.resolve(args.flags.get("workspace-root") ?? process.cwd());
    const timeoutMs = optionalInt(args.flags.get("timeout-ms"));
    if (preset.kind === "api") {
      const compiled = await compilePreset({ preset, presetDir, taskContext, env, workspaceRoot });
      if (compiled.backend !== "api") throw new ClhError("CLH_PRESET_INVALID", "api kind compiled to a non-api backend", {});
      callApiPreset({
        preset,
        system: compiled.system,
        prompt: compiled.prompt,
        timeoutMs,
      }).then(print, fail);
      return;
    }
    runDshPreset({
      preset,
      presetDir,
      taskContext,
      env,
      workspaceRoot,
      timeoutMs,
    }).then(print, fail);
    return;
  }
  if (command === "call") {
    const presetPath = requirePositional(args, 0, "preset.yaml");
    const { preset } = loadPreset(presetPath);
    const promptFile = args.flags.get("prompt-file");
    const promptFlag = args.flags.get("prompt");
    if (!promptFile && !promptFlag) {
      throw new ClhError("CLH_PRESET_INVALID", "clh call requires --prompt-file or --prompt", {});
    }
    const prompt = promptFile ? readFileSync(promptFile, "utf8") : (promptFlag as string);
    const systemFile = args.flags.get("system-file");
    const system = systemFile ? readFileSync(systemFile, "utf8") : undefined;
    const timeoutMs = optionalInt(args.flags.get("timeout-ms"));
    callApiPreset({ preset, system, prompt, timeoutMs }).then(print, fail);
    return;
  }
  throw new ClhError(
    "CLH_PRESET_INVALID",
    "Usage: clh <validate|compile|run|call> <preset.yaml> [flags]",
    {},
  );
}

function requirePositional(args: CliArgs, index: number, label: string): string {
  const value = args.positional[index];
  if (!value) {
    throw new ClhError("CLH_PRESET_INVALID", `Missing required argument: ${label}`, {});
  }
  return value;
}

function optionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(error: unknown): void {
  process.stderr.write(
    isClhError(error) ? `${error.code}: ${error.message}\n` : `CLH_PRESET_INVALID: ${String(error)}\n`,
  );
  process.exit(1);
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch(fail);
}
