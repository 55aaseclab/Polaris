import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyHostCacheMigration,
  createHostCacheMigrationPlan,
  rollbackHostCacheMigration,
  verifyHostCacheMigration,
  writeHostCacheDryRunReport,
} from "./migrations/host-cache.js";
import { polarisCacheRoot, polarisDataRoot } from "./utils/paths.js";

type Mode = "dry-run" | "apply" | "verify" | "rollback";

interface Options {
  mode: Mode;
  sourceRoot?: string;
  targetRoot?: string;
  report?: string;
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  tsx scripts/migrate-host-cache.ts --source-root <dir> --report <file>",
    "  tsx scripts/migrate-host-cache.ts --apply --source-root <dir> --report <file>",
    "  tsx scripts/migrate-host-cache.ts --verify --report <file>",
    "  tsx scripts/migrate-host-cache.ts --rollback --report <file>",
  ].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Options = { mode: "dry-run" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply" || value === "--verify" || value === "--rollback") {
      if (options.mode !== "dry-run") usage();
      options.mode = value.slice(2) as Mode;
      continue;
    }
    if (["--source-root", "--target-root", "--report"].includes(value)) {
      const next = argv[index + 1]?.trim();
      if (!next) usage();
      index += 1;
      if (value === "--source-root") options.sourceRoot = next;
      if (value === "--target-root") options.targetRoot = next;
      if (value === "--report") options.report = next;
      continue;
    }
    usage();
  }
  if (!options.report) usage();
  if ((options.mode === "dry-run" || options.mode === "apply") && !options.sourceRoot) {
    usage();
  }
  return options;
}

export function runHostCacheMigrationCli(argv: string[]): unknown {
  const options = parseArgs(argv);
  const targetRoot = path.resolve(
    options.targetRoot ?? polarisCacheRoot(import.meta.url),
  );
  const reportPath = path.resolve(options.report!);
  if (options.mode === "verify") {
    return verifyHostCacheMigration({ reportPath, targetRoot });
  }
  if (options.mode === "rollback") {
    return rollbackHostCacheMigration({ reportPath, targetRoot });
  }
  const plan = createHostCacheMigrationPlan({
    sourceRoot: path.resolve(options.sourceRoot!),
    targetRoot,
  });
  if (options.mode === "apply") {
    return applyHostCacheMigration({ plan, reportPath });
  }
  return writeHostCacheDryRunReport(reportPath, plan);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    polarisDataRoot(import.meta.url);
    process.stdout.write(`${JSON.stringify(runHostCacheMigrationCli(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
