#!/usr/bin/env node
/**
 * CLH dispatcher exec adapter (PRD 3.14.5). Mounted as the dsh sandbox
 * runnerCommand; receives bwrap-compatible profile arguments, then the wrapped
 * command after a `--` separator (or as the whole argv when no separator is
 * present). Every command forwards to the dispatcher endpoint over HTTP and
 * never executes locally; a missing dispatcher URL fails closed.
 *
 * Protocol (POST POLARIS_CLH_DISPATCHER_URL):
 *   { profileArgs: string[], command: string[], cwd: string }
 *   -> { exitCode: number, stdout: string, stderr: string }
 */
import { pathToFileURL } from "node:url";
import { ClhError } from "./errors.js";

interface DispatcherResponse {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export function splitArgv(argv: string[]): { profileArgs: string[]; command: string[] } {
  const separator = argv.indexOf("--");
  if (separator === -1) {
    return { profileArgs: [], command: argv };
  }
  return {
    profileArgs: argv.slice(0, separator),
    command: argv.slice(separator + 1),
  };
}

export async function runAdapter(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { profileArgs, command } = splitArgv(argv);
  if (command.length === 0) {
    process.stderr.write("clh-dispatcher: CLH_DISPATCHER_URL_MISSING no wrapped command in argv\n");
    return 1;
  }
  const url = env["POLARIS_CLH_DISPATCHER_URL"];
  if (!url) {
    process.stderr.write(
      "clh-dispatcher: CLH_DISPATCHER_URL_MISSING no dispatcher endpoint in the environment; export POLARIS_CLH_DISPATCHER_URL\n",
    );
    return 1;
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileArgs, command, cwd: process.cwd() }),
    });
  } catch (error) {
    process.stderr.write(`clh-dispatcher: CLH_API_STATUS dispatcher endpoint unreachable: ${String(error)}\n`);
    return 1;
  }
  if (!response.ok) {
    const snippet = (await response.text()).slice(0, 400);
    process.stderr.write(`clh-dispatcher: CLH_API_STATUS dispatcher returned ${response.status}: ${snippet}\n`);
    return 1;
  }
  const payload = (await response.json()) as DispatcherResponse;
  if (typeof payload.stdout === "string" && payload.stdout.length > 0) {
    process.stdout.write(payload.stdout);
  }
  if (typeof payload.stderr === "string" && payload.stderr.length > 0) {
    process.stderr.write(payload.stderr);
  }
  const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : 1;
  return exitCode;
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  runAdapter(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      const message = error instanceof ClhError ? `${error.code}: ${error.message}` : String(error);
      process.stderr.write(`clh-dispatcher: CLH_API_STATUS ${message}\n`);
      process.exit(1);
    },
  );
}
