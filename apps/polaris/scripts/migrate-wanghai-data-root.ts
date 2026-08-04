import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyWanghaiDataRootMigration,
  createWanghaiDataRootMigrationPlan,
  readWanghaiMigrationManifest,
  rollbackWanghaiDataRootMigration,
  verifyWanghaiDataRootMigration,
  writeWanghaiMigrationDryRunReport,
} from "./migrations/wanghai-data-root.js";

type Mode = "dry-run" | "apply" | "verify" | "rollback";

interface Options {
  mode: Mode;
  manifest?: string;
  legacyRoot?: string;
  targetRoot?: string;
  report?: string;
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  tsx scripts/migrate-wanghai-data-root.ts --manifest <file> --legacy-root <dir> --target-root <dir> --report <file>",
    "  tsx scripts/migrate-wanghai-data-root.ts --apply --manifest <file> --legacy-root <dir> --target-root <dir> --report <file>",
    "  tsx scripts/migrate-wanghai-data-root.ts --verify --target-root <dir> --report <file>",
    "  tsx scripts/migrate-wanghai-data-root.ts --rollback --target-root <dir> --report <file>",
  ].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Options = { mode: "dry-run" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply" || value === "--verify" || value === "--rollback") {
      const nextMode = value.slice(2) as Mode;
      if (options.mode !== "dry-run") {
        usage();
      }
      options.mode = nextMode;
      continue;
    }
    if (["--manifest", "--legacy-root", "--target-root", "--report"].includes(value)) {
      const next = argv[index + 1]?.trim();
      if (!next) {
        usage();
      }
      index += 1;
      if (value === "--manifest") options.manifest = next;
      if (value === "--legacy-root") options.legacyRoot = next;
      if (value === "--target-root") options.targetRoot = next;
      if (value === "--report") options.report = next;
      continue;
    }
    usage();
  }
  if (!options.targetRoot || !options.report) {
    usage();
  }
  if ((options.mode === "dry-run" || options.mode === "apply")
    && (!options.manifest || !options.legacyRoot)) {
    usage();
  }
  return options;
}

export function runWanghaiDataRootMigrationCli(argv: string[]): unknown {
  const options = parseArgs(argv);
  const targetRoot = path.resolve(options.targetRoot!);
  const reportPath = path.resolve(options.report!);
  if (options.mode === "verify") {
    return verifyWanghaiDataRootMigration({ reportPath, targetRoot });
  }
  if (options.mode === "rollback") {
    return rollbackWanghaiDataRootMigration({ reportPath, targetRoot });
  }

  const { manifest, digest } = readWanghaiMigrationManifest(path.resolve(options.manifest!));
  const plan = createWanghaiDataRootMigrationPlan({
    manifest,
    manifestDigest: digest,
    legacyRoot: path.resolve(options.legacyRoot!),
    targetRoot,
  });
  if (options.mode === "apply") {
    return applyWanghaiDataRootMigration({ plan, reportPath });
  }
  return writeWanghaiMigrationDryRunReport(reportPath, plan);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runWanghaiDataRootMigrationCli(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
