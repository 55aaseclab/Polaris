import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const coverageDir = path.join(process.cwd(), ".coverage");
fs.mkdirSync(coverageDir, { recursive: true });
const testFiles = fs.readdirSync(path.join(process.cwd(), "tests"))
  .filter((entry) => entry.endsWith(".test.ts"))
  .sort()
  .map((entry) => `tests/${entry}`);

const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--experimental-test-coverage",
    "--test",
    ...testFiles,
  ],
  {
    cwd: process.cwd(),
    encoding: "utf8",
  },
);

const stdout = result.stdout || "";
const stderr = result.stderr || "";
process.stdout.write(stdout);
process.stderr.write(stderr);

const rawPath = path.join(coverageDir, "coverage.txt");
fs.writeFileSync(rawPath, `${stdout}${stderr}`, "utf8");

const summary = {};
for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
  const normalized = line.startsWith("# ") ? line.slice(2) : line;
  if (!normalized.includes("|")) {
    continue;
  }
  const columns = normalized.split("|").map((part) => part.trim());
  if (columns.length < 4) {
    continue;
  }
  const [name, linePct, branchPct, functionPct] = columns;
  if (!name || Number.isNaN(Number(linePct)) || Number.isNaN(Number(branchPct)) || Number.isNaN(Number(functionPct))) {
    continue;
  }
  summary[name.toLowerCase()] = {
    linePct: Number(linePct),
    branchPct: Number(branchPct),
    functionPct: Number(functionPct),
    uncoveredLines: columns[4] || "",
  };
}

fs.writeFileSync(path.join(coverageDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (Object.keys(summary).length === 0) {
  console.error("No coverage summary was detected in the test output.");
  process.exit(1);
}

const total = summary["all files"];
if (total) {
  console.log(
    `Coverage summary: lines ${total.linePct}% | branches ${total.branchPct}% | functions ${total.functionPct}%`,
  );
}
