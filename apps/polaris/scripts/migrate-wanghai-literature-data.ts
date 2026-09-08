import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyWanghaiLiteratureDataMigration,
  createWanghaiLiteratureDataMigrationPlan,
  rollbackWanghaiLiteratureDataMigration,
  verifyWanghaiLiteratureDataMigration,
  writeWanghaiLiteratureDataDryRunReport,
} from "./migrations/wanghai-literature-data.js";

type Mode = "dry-run" | "apply" | "verify" | "rollback";

interface Options {
  mode: Mode;
  sourceRoot?: string;
  archiveRoot?: string;
  tenantId?: string;
  vaultId?: string;
  workspaceId: string;
  report: string;
}
function usage(): never {
  throw new Error([
    "Usage:",
    "  tsx scripts/migrate-wanghai-literature-data.ts --source-root <dir> --archive-root <dir> --tenant-id <id> --vault-id <id> --workspace-id <id> --report <file>",
    "  tsx scripts/migrate-wanghai-literature-data.ts --apply --source-root <dir> --archive-root <dir> --tenant-id <id> --vault-id <id> --workspace-id <id> --report <file>",
    "  tsx scripts/migrate-wanghai-literature-data.ts --verify --archive-root <dir> --report <file>",
    "  tsx scripts/migrate-wanghai-literature-data.ts --rollback --archive-root <dir> --report <file>",
  ].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Options = { mode: "dry-run", workspaceId: "literature-review", report: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply" || value === "--verify" || value === "--rollback") {
      if (options.mode !== "dry-run") usage();
      options.mode = value.slice(2) as Mode;
      continue;
    }
    const next = argv[index + 1]?.trim();
    if (["--source-root", "--archive-root", "--tenant-id", "--vault-id", "--workspace-id", "--report"].includes(value)) {
      if (!next) usage();
      index += 1;
      if (value === "--source-root") options.sourceRoot = next;
      if (value === "--archive-root") options.archiveRoot = next;
      if (value === "--tenant-id") options.tenantId = next;
      if (value === "--vault-id") options.vaultId = next;
      if (value === "--workspace-id") options.workspaceId = next;
      if (value === "--report") options.report = next;
      continue;
    }
    usage();
  }
  if (!options.archiveRoot || !options.report) usage();
  if ((options.mode === "dry-run" || options.mode === "apply")
    && (!options.sourceRoot || !options.tenantId || !options.vaultId)) usage();
  return options;
}

export function runWanghaiLiteratureDataMigrationCli(argv: string[]): unknown {
  const options = parseArgs(argv);
  const archiveRoot = path.resolve(options.archiveRoot!);
  const report = path.resolve(options.report);
  if (options.mode === "verify") {
    return verifyWanghaiLiteratureDataMigration({ reportPath: report, archiveRoot });
  }
  if (options.mode === "rollback") {
    return rollbackWanghaiLiteratureDataMigration({ reportPath: report, archiveRoot });
  }
  const plan = createWanghaiLiteratureDataMigrationPlan({
    sourceRoot: path.resolve(options.sourceRoot!),
    archiveRoot,
    scope: {
      tenantId: options.tenantId!,
      vaultId: options.vaultId!,
      workspaceId: options.workspaceId,
    },
  });
  if (options.mode === "apply") {
    return applyWanghaiLiteratureDataMigration({ plan, reportPath: report });
  }
  return writeWanghaiLiteratureDataDryRunReport(report, plan);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runWanghaiLiteratureDataMigrationCli(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
