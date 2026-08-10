import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyControlVaultDataMigration,
  createControlVaultDataMigrationPlan,
  readControlVaultDataManifest,
  rollbackControlVaultDataMigration,
  verifyControlVaultDataMigration,
  writeControlVaultDataDryRunReport,
} from "./migrations/control-vault-data.js";

type Mode = "dry-run" | "apply" | "verify" | "rollback";

interface Options {
  mode: Mode;
  manifest?: string;
  dataRoot?: string;
  targetExportRoot?: string;
  report?: string;
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  tsx scripts/migrate-control-vault-data.ts --manifest <file> --data-root <dir> --report <file>",
    "  tsx scripts/migrate-control-vault-data.ts --apply --manifest <file> --data-root <dir> --report <file>",
    "  tsx scripts/migrate-control-vault-data.ts --verify --data-root <dir> --report <file>",
    "  tsx scripts/migrate-control-vault-data.ts --rollback --data-root <dir> --report <file>",
  ].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Options = { mode: "dry-run" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") {
      if (index !== 0) usage();
      continue;
    }
    if (value === "--apply" || value === "--verify" || value === "--rollback") {
      if (options.mode !== "dry-run") usage();
      options.mode = value.slice(2) as Mode;
      continue;
    }
    if (["--manifest", "--data-root", "--target-export-root", "--report"].includes(value)) {
      const next = argv[index + 1]?.trim();
      if (!next) usage();
      index += 1;
      if (value === "--manifest") options.manifest = next;
      if (value === "--data-root") options.dataRoot = next;
      if (value === "--target-export-root") options.targetExportRoot = next;
      if (value === "--report") options.report = next;
      continue;
    }
    usage();
  }
  if (!options.dataRoot || !options.report) usage();
  if ((options.mode === "dry-run" || options.mode === "apply") && !options.manifest) usage();
  return options;
}

export function runControlVaultDataMigrationCli(argv: string[]): unknown {
  const options = parseArgs(argv);
  const dataRoot = path.resolve(options.dataRoot!);
  const reportPath = path.resolve(options.report!);
  if (options.mode === "verify") {
    return verifyControlVaultDataMigration({ reportPath, targetRoot: dataRoot });
  }
  if (options.mode === "rollback") {
    return rollbackControlVaultDataMigration({ reportPath, targetRoot: dataRoot });
  }
  const { manifest, digest } = readControlVaultDataManifest(path.resolve(options.manifest!));
  const plan = createControlVaultDataMigrationPlan({
    manifest,
    manifestDigest: digest,
    legacyRoot: dataRoot,
    targetRoot: dataRoot,
    targetExportRoot: options.targetExportRoot,
  });
  if (options.mode === "apply") {
    return applyControlVaultDataMigration({ plan, reportPath });
  }
  return writeControlVaultDataDryRunReport(reportPath, plan);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runControlVaultDataMigrationCli(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
