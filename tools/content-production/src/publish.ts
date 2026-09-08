import fs from "node:fs";
import path from "node:path";
import { writeJsonFile } from "@polaris/business-core";
import { sha256File, sha256Json } from "./hash.js";
import { toWorkspaceRelative, utcNow } from "./paths.js";
import { parseCatalogOutput, parseContentProductionOutput } from "./validate.js";
import type {
  CatalogOutput,
  CatalogSnapshot,
  ContentProductionInput,
  ContentProductionOutput,
} from "./types.js";

export function buildCatalogOutput(args: {
  workspaceRoot: string;
  snapshot: CatalogSnapshot;
  inputSha256: string;
  snapshotPath: string;
  htmlPath: string;
  pdfPath: string;
  manifestPath: string;
  warnings?: string[];
}): CatalogOutput {
  const { workspaceRoot, snapshot } = args;
  let pageIndex = snapshot.include_sections.cover ? 1 : 0;
  const products = snapshot.pages.map((page) => {
    pageIndex += 1;
    return {
      product_id: page.product_id,
      slug: page.slug,
      batch: page.batch,
      name: page.display_name,
      page_index: pageIndex,
      images_used: {
        near: page.images.near?.path ?? null,
        wear: page.images.wear?.path ?? null,
        detail: page.images.detail?.path ?? null,
      },
      price_shown: {
        currency: page.price.currency,
        amount: page.price.amount,
        policy: page.price.policy,
      },
      source_meta_sha256: page.source_meta_sha256,
    };
  });

  const requested = products.length + snapshot.skipped.length;
  const output: CatalogOutput = {
    schema: "wanghai.promo.catalog-output",
    schema_version: 1,
    catalog_id: snapshot.catalog_id,
    status: "published",
    generated_at: utcNow(),
    input_sha256: args.inputSha256,
    snapshot_sha256: sha256File(args.snapshotPath),
    template_id: snapshot.template_id,
    locale: snapshot.locale,
    market: snapshot.market,
    counts: {
      requested,
      included: products.length,
      skipped: snapshot.skipped.length,
    },
    products,
    skipped: snapshot.skipped.map((item) => ({
      product_id: item.product_id,
      reason: item.reason,
      detail: item.detail ?? null,
    })),
    artifacts: {
      html: toWorkspaceRelative(workspaceRoot, args.htmlPath),
      pdf: toWorkspaceRelative(workspaceRoot, args.pdfPath),
      snapshot: toWorkspaceRelative(workspaceRoot, args.snapshotPath),
      manifest: toWorkspaceRelative(workspaceRoot, args.manifestPath),
    },
    warnings: args.warnings ?? [],
  };

  parseCatalogOutput(output);
  return output;
}

export function writeCatalogOutput(manifestPath: string, output: CatalogOutput): void {
  writeJsonFile(manifestPath, output);
}

export function writeRunManifest(runDir: string, payload: Record<string, unknown>): void {
  fs.mkdirSync(runDir, { recursive: true });
  writeJsonFile(path.join(runDir, "run.json"), payload);
}

export function snapshotSha(snapshot: CatalogSnapshot): string {
  return sha256Json(snapshot);
}

export function buildContentProductionOutput(args: {
  workspaceRoot: string;
  contentInput: ContentProductionInput;
  catalogOutput: CatalogOutput;
  snapshotPath: string;
  htmlPath: string;
  pdfPath: string | null;
  manifestPath: string;
  pageCount: number;
  phaseLog: ContentProductionOutput["phases"];
  warnings?: string[];
}): ContentProductionOutput {
  const { catalogOutput, contentInput } = args;
  const output: ContentProductionOutput = {
    schema_version: "wanghai.content-production.output.v1",
    job_id: contentInput.job_id,
    content_kind: "product-catalog",
    status: "published",
    generated_at: utcNow(),
    input_sha256: catalogOutput.input_sha256,
    snapshot_sha256: catalogOutput.snapshot_sha256,
    locale: contentInput.locale,
    market: contentInput.market,
    counts: { ...catalogOutput.counts },
    products_used: catalogOutput.products.map((p) => ({
      product_id: p.product_id,
      slug: p.slug,
      batch: p.batch,
      name: p.name,
      source_meta_sha256: p.source_meta_sha256,
      role: `page-${p.page_index}`,
    })),
    skipped: catalogOutput.skipped.map((s) => ({
      product_id: s.product_id,
      reason: s.reason,
      detail: s.detail ?? null,
    })),
    phases: args.phaseLog,
    artifacts: {
      manifest: toWorkspaceRelative(args.workspaceRoot, args.manifestPath),
      primary: args.pdfPath
        ? toWorkspaceRelative(args.workspaceRoot, args.pdfPath)
        : toWorkspaceRelative(args.workspaceRoot, args.htmlPath),
      preview: toWorkspaceRelative(args.workspaceRoot, args.htmlPath),
      snapshot: toWorkspaceRelative(args.workspaceRoot, args.snapshotPath),
      plan: null,
      extras: [],
    },
    kind_output: {
      product_catalog: {
        template_id: catalogOutput.template_id,
        page_count: args.pageCount,
        pdf: args.pdfPath
          ? toWorkspaceRelative(args.workspaceRoot, args.pdfPath)
          : null,
        html: toWorkspaceRelative(args.workspaceRoot, args.htmlPath),
        catalog_output_ref: null,
      },
      carousel: null,
      video: null,
    },
    warnings: args.warnings ?? catalogOutput.warnings,
  };
  parseContentProductionOutput(output);
  return output;
}

export function writeContentProductionOutput(
  manifestPath: string,
  output: ContentProductionOutput,
): void {
  writeJsonFile(manifestPath, output);
}
