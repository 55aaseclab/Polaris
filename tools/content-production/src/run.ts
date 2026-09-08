import fs from "node:fs";
import path from "node:path";
import { findChrome, renderHtmlToPdf, writeJsonFile } from "@polaris/business-core";
import { sha256Json } from "./hash.js";
import {
  contentInputToCatalogInput,
  defaultContentInput,
  isContentProductionInput,
} from "./content-map.js";
import {
  catalogCaseDir,
  ensureDir,
  jobCaseDir,
  toolVersion,
  toWorkspaceRelative,
  utcNow,
} from "./paths.js";
import {
  buildCatalogOutput,
  buildContentProductionOutput,
  writeCatalogOutput,
  writeContentProductionOutput,
  writeRunManifest,
} from "./publish.js";
import { renderCatalogHtml } from "./render.js";
import { defaultCatalogInput, resolveCatalog } from "./resolve.js";
import {
  CatalogError,
  type CatalogInput,
  type CatalogSnapshot,
  type ContentProductionInput,
  type ContentProductionOutput,
} from "./types.js";
import {
  parseAnyJobInput,
  parseCatalogInput,
  parseCatalogSnapshot,
  parseContentProductionInput,
  readJson,
} from "./validate.js";

export type RunOptions = {
  workspaceRoot: string;
  input?: CatalogInput | ContentProductionInput;
  inputPath?: string;
  outDir?: string;
  strict?: boolean;
  skipPdf?: boolean;
};

export type RunResult = {
  contentKind: "product-catalog";
  snapshot: CatalogSnapshot;
  outputPath: string;
  htmlPath: string;
  pdfPath: string | null;
  snapshotPath: string;
  contentOutput?: ContentProductionOutput;
};

function phase(
  name: string,
  status: ContentProductionOutput["phases"][number]["status"],
  detail: string | null = null,
  artifact_paths: string[] = [],
): ContentProductionOutput["phases"][number] {
  const now = utcNow();
  return {
    phase: name,
    status,
    started_at: now,
    finished_at: now,
    detail,
    artifact_paths,
  };
}

function loadJob(options: RunOptions): {
  catalogInput: CatalogInput;
  contentInput: ContentProductionInput | null;
  inputPath: string | null;
  rawForHash: unknown;
} {
  if (options.input) {
    if (isContentProductionInput(options.input)) {
      const contentInput = parseContentProductionInput(options.input);
      return {
        catalogInput: contentInputToCatalogInput(contentInput),
        contentInput,
        inputPath: options.inputPath ?? null,
        rawForHash: contentInput,
      };
    }
    const catalogInput = parseCatalogInput(options.input);
    return {
      catalogInput,
      contentInput: null,
      inputPath: options.inputPath ?? null,
      rawForHash: catalogInput,
    };
  }
  if (!options.inputPath) {
    throw new CatalogError("either input or inputPath is required", 2);
  }
  const absolute = path.isAbsolute(options.inputPath)
    ? options.inputPath
    : path.resolve(options.workspaceRoot, options.inputPath);
  const parsed = parseAnyJobInput(readJson(absolute));
  if (parsed.kind === "content") {
    return {
      catalogInput: contentInputToCatalogInput(parsed.input),
      contentInput: parsed.input,
      inputPath: absolute,
      rawForHash: parsed.input,
    };
  }
  return {
    catalogInput: parsed.input,
    contentInput: null,
    inputPath: absolute,
    rawForHash: parsed.input,
  };
}

function resolveOutDir(
  workspaceRoot: string,
  catalogInput: CatalogInput,
  contentInput: ContentProductionInput | null,
  outDir?: string,
): string {
  if (outDir) {
    return path.isAbsolute(outDir) ? outDir : path.resolve(workspaceRoot, outDir);
  }
  if (contentInput) {
    return jobCaseDir(workspaceRoot, contentInput.job_id, contentInput.content_kind);
  }
  return catalogCaseDir(workspaceRoot, catalogInput.catalog_id);
}

/** Primary entry: content-production or legacy catalog-input. */
export function runContentProduction(options: RunOptions): RunResult {
  const started = Date.now();
  const { catalogInput, contentInput, inputPath, rawForHash } = loadJob(options);
  const strict = options.strict ?? contentInput?.pipeline.strict ?? false;
  const skipPdf =
    options.skipPdf ?? contentInput?.pipeline.skip_package ?? false;

  if (contentInput && contentInput.pipeline.review_mode === "manual-review") {
    // v1: still produce artifacts; mark awaiting only if we later gate publish.
    // For now auto-complete and warn.
  }

  const outDir = resolveOutDir(
    options.workspaceRoot,
    catalogInput,
    contentInput,
    options.outDir,
  );
  const inputsDir = path.join(outDir, "inputs");
  const workDir = path.join(outDir, "work");
  const outputsDir = path.join(outDir, "outputs");
  const runsDir = path.join(outDir, "runs", utcNow().replace(/[:.]/g, "-"));
  ensureDir(inputsDir);
  ensureDir(workDir);
  ensureDir(outputsDir);
  ensureDir(runsDir);

  const savedInputPath = path.join(inputsDir, "input.json");
  writeJsonFile(savedInputPath, rawForHash);

  const phases: ContentProductionOutput["phases"] = [
    phase("validate", "ok"),
  ];

  const snapshot = resolveCatalog(options.workspaceRoot, catalogInput);
  phases.push(
    phase("select", "ok", null, []),
    phase("freeze", snapshot.pages.length ? "ok" : "failed", null, []),
  );

  if (snapshot.pages.length === 0) {
    writeJsonFile(path.join(workDir, "snapshot.json"), snapshot);
    writeRunManifest(runsDir, {
      schema: "wanghai.content-production.run",
      schema_version: 1,
      status: "failed",
      reason: "no_products_included",
      tool_version: toolVersion(),
      skipped: snapshot.skipped,
    });
    throw new CatalogError(
      `no products included (requested ${snapshot.skipped.length + snapshot.pages.length}, all skipped)`,
      3,
    );
  }
  if (strict && snapshot.skipped.length > 0) {
    writeJsonFile(path.join(workDir, "snapshot.json"), snapshot);
    throw new CatalogError(
      `strict mode: ${snapshot.skipped.length} product(s) skipped`,
      5,
    );
  }

  const snapshotPath = path.join(workDir, "snapshot.json");
  writeJsonFile(snapshotPath, snapshot);
  parseCatalogSnapshot(snapshot);
  phases.push(phase("plan", "ok", "single-product-page sections from include_sections"));

  const workHtmlPath = path.join(workDir, "render.html");
  const renderResult = renderCatalogHtml(options.workspaceRoot, snapshot, workHtmlPath);
  phases.push(
    phase("produce", "ok", null, [toWorkspaceRelative(options.workspaceRoot, workHtmlPath)]),
  );

  const htmlPath = path.join(outputsDir, "catalog.html");
  const assetsSrc = path.join(workDir, "assets");
  const assetsDst = path.join(outputsDir, "assets");
  fs.cpSync(workHtmlPath, htmlPath);
  if (fs.existsSync(assetsSrc)) {
    fs.cpSync(assetsSrc, assetsDst, { recursive: true });
  }

  let pdfPath: string | null = path.join(outputsDir, "catalog.pdf");
  if (skipPdf) {
    pdfPath = null;
    phases.push(phase("package", "skipped", "skip_package/skip-pdf"));
  } else {
    if (!findChrome()) {
      throw new CatalogError("Chrome/Chromium not found on server.", 4);
    }
    renderHtmlToPdf(htmlPath, pdfPath);
    phases.push(
      phase("package", "ok", null, [toWorkspaceRelative(options.workspaceRoot, pdfPath)]),
    );
  }

  const warnings: string[] = [];
  if (snapshot.skipped.length > 0) {
    warnings.push(`${snapshot.skipped.length} product(s) skipped`);
  }
  if (!pdfPath) {
    warnings.push("pdf_skipped");
  }
  if (contentInput?.pipeline.review_mode === "manual-review") {
    warnings.push("review_mode=manual-review treated as auto-pass in v1 tool");
    phases.push(phase("review", "skipped", "auto-pass fallback"));
  } else {
    phases.push(phase("review", "ok", "auto-pass"));
  }

  const manifestPath = path.join(outputsDir, "output.json");
  const pdfForCatalogOutput = pdfPath ?? path.join(outputsDir, "catalog.pdf");
  if (!pdfPath) {
    warnings.push("pdf artifact path reserved but file not generated");
  }

  const inputSha = sha256Json(rawForHash);
  const catalogOutput = buildCatalogOutput({
    workspaceRoot: options.workspaceRoot,
    snapshot,
    inputSha256: inputSha,
    snapshotPath,
    htmlPath,
    pdfPath: pdfForCatalogOutput,
    manifestPath: path.join(outputsDir, "catalog-output.json"),
    warnings,
  });
  // Keep internal catalog-output for debugging / dual readers.
  writeCatalogOutput(path.join(outputsDir, "catalog-output.json"), catalogOutput);

  let contentOutput: ContentProductionOutput | undefined;
  if (contentInput) {
    phases.push(phase("publish", "ok"));
    contentOutput = buildContentProductionOutput({
      workspaceRoot: options.workspaceRoot,
      contentInput,
      catalogOutput,
      snapshotPath,
      htmlPath,
      pdfPath,
      manifestPath,
      pageCount: renderResult.pageCount,
      phaseLog: phases,
      warnings,
    });
    writeContentProductionOutput(manifestPath, contentOutput);
  } else {
    // Legacy catalog-only jobs: output.json stays catalog-output shape.
    writeCatalogOutput(manifestPath, {
      ...catalogOutput,
      artifacts: {
        ...catalogOutput.artifacts,
        manifest: toWorkspaceRelative(options.workspaceRoot, manifestPath),
      },
    });
    phases.push(phase("publish", "ok", "legacy catalog-output"));
  }

  writeRunManifest(runsDir, {
    schema: "wanghai.content-production.run",
    schema_version: 1,
    status: "ok",
    tool_version: toolVersion(),
    content_kind: "product-catalog",
    started_at: new Date(started).toISOString(),
    finished_at: utcNow(),
    duration_ms: Date.now() - started,
    input_path: inputPath
      ? toWorkspaceRelative(options.workspaceRoot, inputPath)
      : null,
    saved_input: toWorkspaceRelative(options.workspaceRoot, savedInputPath),
    snapshot: toWorkspaceRelative(options.workspaceRoot, snapshotPath),
    html: toWorkspaceRelative(options.workspaceRoot, htmlPath),
    pdf: pdfPath ? toWorkspaceRelative(options.workspaceRoot, pdfPath) : null,
    manifest: toWorkspaceRelative(options.workspaceRoot, manifestPath),
    counts: catalogOutput.counts,
    warnings,
    phases,
  });

  return {
    contentKind: "product-catalog",
    snapshot,
    outputPath: manifestPath,
    htmlPath,
    pdfPath,
    snapshotPath,
    contentOutput,
  };
}

/** @deprecated Use runContentProduction — catalog is content_kind=product-catalog. */
export const runCatalog = runContentProduction;

export function initInputFile(args: {
  workspaceRoot: string;
  jobId: string;
  /** @deprecated alias of jobId */
  catalogId?: string;
  productIds?: number[];
  batch?: string;
  external?: boolean;
  locale?: "zh" | "en";
  market?: string;
  title?: string;
  brandName?: string;
  outputPath?: string;
  /** Write legacy catalog-input instead of umbrella content-production input. */
  legacyCatalog?: boolean;
}): string {
  const jobId = args.jobId || args.catalogId;
  if (!jobId) {
    throw new CatalogError("jobId (or catalogId) is required", 2);
  }
  const mode = args.external
    ? "external"
    : args.batch && !args.productIds?.length
      ? "batch"
      : "explicit";

  if (args.legacyCatalog) {
    const input = defaultCatalogInput({
      catalog_id: jobId,
      title: args.title,
      product_ids: args.productIds,
      batch: args.batch ?? null,
      mode,
      locale: args.locale,
      market: args.market,
      brand_name: args.brandName,
    });
    parseCatalogInput(input);
    const out =
      args.outputPath ??
      path.join(catalogCaseDir(args.workspaceRoot, jobId), "inputs", "input.json");
    const absolute = path.isAbsolute(out) ? out : path.resolve(args.workspaceRoot, out);
    ensureDir(path.dirname(absolute));
    writeJsonFile(absolute, input);
    return absolute;
  }

  const input = defaultContentInput({
    job_id: jobId,
    title: args.title,
    product_ids: args.productIds,
    batch: args.batch ?? null,
    mode,
    locale: args.locale,
    market: args.market,
    brand_name: args.brandName,
  });
  parseContentProductionInput(input);
  const out =
    args.outputPath ??
    path.join(
      jobCaseDir(args.workspaceRoot, jobId, "product-catalog"),
      "inputs",
      "input.json",
    );
  const absolute = path.isAbsolute(out) ? out : path.resolve(args.workspaceRoot, out);
  ensureDir(path.dirname(absolute));
  writeJsonFile(absolute, input);
  return absolute;
}
