#!/usr/bin/env node
import path from "node:path";
import {
  assertPolarisBusinessCommand,
  findChrome,
  renderHtmlToPdf,
  writeJsonFile,
  PolarisBusinessRuntimeError,
} from "@polaris/business-core";
import { sha256Json } from "./hash.js";
import { contentInputToCatalogInput } from "./content-map.js";
import { catalogCaseDir, jobCaseDir, toolVersion, ensureDir } from "./paths.js";
import { buildCatalogOutput, writeCatalogOutput } from "./publish.js";
import { renderCatalogHtml } from "./render.js";
import { resolveCatalog } from "./resolve.js";
import { initInputFile, runContentProduction } from "./run.js";
import { CatalogError, ContentProductionError } from "./types.js";
import {
  parseAnyJobInput,
  parseCatalogInput,
  parseCatalogSnapshot,
  parseContentProductionInput,
  readJson,
} from "./validate.js";

function printHelp(): void {
  console.log(`polaris-content-production ${toolVersion()}

Content production tool (product-catalog | carousel | video).
v1 implements product-catalog end-to-end; carousel/video are not packaged yet.

Usage:
  polaris-content-production version
  polaris-content-production init-input --workspace-root <path> --job-id <id> [options]
  polaris-content-production resolve --workspace-root <path> --input <path> [--snapshot <path>]
  polaris-content-production render --workspace-root <path> --snapshot <path> [--html <path>]
  polaris-content-production pdf --html <path> --pdf <path>
  polaris-content-production publish --workspace-root <path> --snapshot <path> --html <path> --pdf <path> --output <path>
  polaris-content-production run --workspace-root <path> --input <path> [options]

Input may be:
  - wanghai.content-production.input.v1  (preferred)
  - wanghai.promo.catalog-input          (legacy; still accepted)

run options:
  --out-dir <path>     Case directory override
  --strict             Fail if any product is skipped
  --skip-pdf           Produce HTML + manifest only (no Chromium)

init-input options:
  --job-id <id>        (preferred; was --catalog-id)
  --catalog-id <id>    alias of --job-id
  --product-ids 1,2,3
  --batch <name>
  --external           Select all products marked for external use
  --locale en|zh
  --market CN|CH|...
  --title <text>
  --brand-name <text>
  --output <path>
  --legacy-catalog     Write old catalog-input schema instead of umbrella input
`);
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function requireArg(args: string[], name: string): string {
  const value = argValue(args, name);
  if (!value) throw new CatalogError(`missing required ${name}`, 2);
  return value;
}

function parseIds(text: string | undefined): number[] | undefined {
  if (!text) return undefined;
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((n) => Number.isInteger(n));
}

function main(argv: string[]): number {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  if (command === "version") {
    console.log(toolVersion());
    return 0;
  }

  try {
    assertPolarisBusinessCommand(command);
    if (command === "init-input") {
      const workspaceRoot = path.resolve(requireArg(args, "--workspace-root"));
      const jobId = argValue(args, "--job-id") ?? argValue(args, "--catalog-id");
      if (!jobId) throw new CatalogError("missing required --job-id (or --catalog-id)", 2);
      const external = args.includes("--external");
      if (external && (argValue(args, "--product-ids") || argValue(args, "--batch"))) {
        throw new CatalogError("--external cannot be combined with --product-ids or --batch", 2);
      }
      const out = initInputFile({
        workspaceRoot,
        jobId,
        external,
        productIds: parseIds(argValue(args, "--product-ids")),
        batch: argValue(args, "--batch"),
        locale: (argValue(args, "--locale") as "zh" | "en" | undefined) ?? "en",
        market: argValue(args, "--market") ?? "CN",
        title: argValue(args, "--title"),
        brandName: argValue(args, "--brand-name"),
        outputPath: argValue(args, "--output"),
        legacyCatalog: args.includes("--legacy-catalog"),
      });
      console.log(out);
      return 0;
    }

    if (command === "resolve") {
      const workspaceRoot = path.resolve(requireArg(args, "--workspace-root"));
      const inputPath = path.resolve(requireArg(args, "--input"));
      const parsed = parseAnyJobInput(readJson(inputPath));
      const catalogInput =
        parsed.kind === "content"
          ? contentInputToCatalogInput(parsed.input)
          : parsed.input;
      const snapshot = resolveCatalog(workspaceRoot, catalogInput);
      const jobId =
        parsed.kind === "content" ? parsed.input.job_id : parsed.input.catalog_id;
      const kind =
        parsed.kind === "content" ? parsed.input.content_kind : "product-catalog";
      const snapshotPath = path.resolve(
        argValue(args, "--snapshot") ??
          path.join(jobCaseDir(workspaceRoot, jobId, kind), "work", "snapshot.json"),
      );
      ensureDir(path.dirname(snapshotPath));
      writeJsonFile(snapshotPath, snapshot);
      console.log(JSON.stringify({
        snapshot: snapshotPath,
        included: snapshot.pages.length,
        skipped: snapshot.skipped.length,
      }, null, 2));
      if (snapshot.pages.length === 0) return 3;
      return 0;
    }

    if (command === "render") {
      const workspaceRoot = path.resolve(requireArg(args, "--workspace-root"));
      const snapshotPath = path.resolve(requireArg(args, "--snapshot"));
      const snapshot = parseCatalogSnapshot(readJson(snapshotPath));
      const htmlPath = path.resolve(
        argValue(args, "--html") ??
          path.join(catalogCaseDir(workspaceRoot, snapshot.catalog_id), "work", "render.html"),
      );
      const result = renderCatalogHtml(workspaceRoot, snapshot, htmlPath);
      console.log(JSON.stringify({ html: htmlPath, page_count: result.pageCount }, null, 2));
      return 0;
    }

    if (command === "pdf") {
      const htmlPath = path.resolve(requireArg(args, "--html"));
      const pdfPath = path.resolve(requireArg(args, "--pdf"));
      if (!findChrome()) throw new CatalogError("Chrome/Chromium not found on server.", 4);
      ensureDir(path.dirname(pdfPath));
      renderHtmlToPdf(htmlPath, pdfPath);
      console.log(pdfPath);
      return 0;
    }

    if (command === "publish") {
      const workspaceRoot = path.resolve(requireArg(args, "--workspace-root"));
      const snapshotPath = path.resolve(requireArg(args, "--snapshot"));
      const htmlPath = path.resolve(requireArg(args, "--html"));
      const pdfPath = path.resolve(requireArg(args, "--pdf"));
      const outputPath = path.resolve(requireArg(args, "--output"));
      const snapshot = parseCatalogSnapshot(readJson(snapshotPath));
      const output = buildCatalogOutput({
        workspaceRoot,
        snapshot,
        inputSha256: snapshot.from_input_sha256,
        snapshotPath,
        htmlPath,
        pdfPath,
        manifestPath: outputPath,
      });
      writeCatalogOutput(outputPath, output);
      console.log(outputPath);
      return 0;
    }

    if (command === "run") {
      const workspaceRoot = path.resolve(requireArg(args, "--workspace-root"));
      const inputPath = requireArg(args, "--input");
      const result = runContentProduction({
        workspaceRoot,
        inputPath,
        outDir: argValue(args, "--out-dir"),
        strict: args.includes("--strict"),
        skipPdf: args.includes("--skip-pdf"),
      });
      const absoluteInput = path.isAbsolute(inputPath)
        ? inputPath
        : path.resolve(workspaceRoot, inputPath);
      console.log(JSON.stringify({
        content_kind: result.contentKind,
        output: result.outputPath,
        html: result.htmlPath,
        pdf: result.pdfPath,
        included: result.snapshot.pages.length,
        skipped: result.snapshot.skipped.length,
        input_sha256: sha256Json(readJson(absoluteInput)),
      }, null, 2));
      return 0;
    }

    throw new CatalogError(`unknown command: ${command}`, 2);
  } catch (error) {
    if (
      error instanceof CatalogError
      || error instanceof ContentProductionError
      || error instanceof PolarisBusinessRuntimeError
    ) {
      console.error(error.message);
      return error instanceof PolarisBusinessRuntimeError ? 2 : error.exitCode;
    }
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    return 1;
  }
}

const code = main(process.argv.slice(2));
process.exit(code);
