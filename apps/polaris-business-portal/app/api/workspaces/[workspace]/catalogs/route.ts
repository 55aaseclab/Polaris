import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { workspaceRelativePath } from "@polaris/business-core/workspaces";
import { workspaceFromContext, type RouteContext } from "../../../_lib";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function readJson(filePath: string): JsonRecord | null {
  try {
    return asRecord(JSON.parse(fs.readFileSync(filePath, "utf-8")));
  } catch {
    return null;
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function listCatalogs(workspaceRoot: string, catalogsDir: string) {
  if (!fs.existsSync(catalogsDir) || !fs.statSync(catalogsDir).isDirectory()) {
    return [];
  }

  return fs.readdirSync(catalogsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const caseDir = path.join(catalogsDir, entry.name);
      const outputPath = path.join(caseDir, "outputs", "output.json");
      const pdfPath = path.join(caseDir, "outputs", "catalog.pdf");
      if (!isFile(outputPath) || !isFile(pdfPath)) return [];

      const output = readJson(outputPath);
      if (output?.schema !== "wanghai.promo.catalog-output") return [];
      const input = readJson(path.join(caseDir, "inputs", "input.json"));
      const counts = asRecord(output.counts) ?? {};
      const pdfStat = fs.statSync(pdfPath);
      const generatedAt = asText(output.generated_at) ?? pdfStat.mtime.toISOString();
      return [{
        catalog_id: asText(output.catalog_id) ?? entry.name,
        generated_at: generatedAt,
        locale: asText(output.locale),
        market: asText(output.market),
        products_included: asCount(counts.included),
        products_skipped: asCount(counts.skipped),
        pdf: {
          modified_at: pdfStat.mtime.toISOString(),
          path: workspaceRelativePath(workspaceRoot, pdfPath),
          size: pdfStat.size,
        },
        status: asText(output.status) ?? "published",
        subtitle: asText(input?.subtitle),
        title: asText(input?.title) ?? asText(output.catalog_id) ?? entry.name,
      }];
    })
    .sort((left, right) => right.generated_at.localeCompare(left.generated_at));
}

export async function GET(_request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const { paths, root } = await workspaceFromContext(context);
    const catalogs = listCatalogs(root, path.join(paths.deliverablesDir, "catalogs"));
    return NextResponse.json({ catalogs }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
