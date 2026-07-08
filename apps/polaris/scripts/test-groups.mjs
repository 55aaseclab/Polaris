import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TEST_ROOT = path.resolve("tests");
const LIVE_AUTH_SEGMENT = `${path.sep}live-auth${path.sep}`;

const INFRA_TEST_NAME_PATTERN = [
  "kubevirt",
  "switch ",
  "CLI logs for pod backend",
  "CLI status defaults to the status command and persists ready pod status",
  "status includes the daemon pairing URL when the runtime exposes one",
  "pod backend returns structured observations",
  "switch accepts pod driver variants such as kata",
  "e2e switch chain keeps daemon connectivity across docker, pod:gvisor, pod:kata-container, and kubevirt while exposing timing from logs",
].join("|");

function collectTests(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (absolute.includes(LIVE_AUTH_SEGMENT) || absolute.endsWith(`${path.sep}live-auth`)) {
        continue;
      }
      files.push(...collectTests(absolute));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(path.relative(process.cwd(), absolute));
    }
  }
  return files.sort();
}

const group = process.argv[2] ?? "default";
const testFiles = collectTests(TEST_ROOT);
const args = ["--test", "--test-concurrency=1"];

if (group === "default") {
  args.push(`--test-skip-pattern=${INFRA_TEST_NAME_PATTERN}`);
} else if (group === "infra") {
  args.push(`--test-name-pattern=${INFRA_TEST_NAME_PATTERN}`);
} else {
  process.stderr.write(`Unknown test group '${group}'. Expected 'default' or 'infra'.\n`);
  process.exit(1);
}

args.push(...testFiles);

execFileSync("./node_modules/.bin/tsx", args, {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? "test",
  },
});
