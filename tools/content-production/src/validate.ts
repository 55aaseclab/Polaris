import fs from "node:fs";
import path from "node:path";
import {
  SCHEMAS_DIR,
  isJsonObject,
  type JsonObject,
  type Schema,
  validateJsonObject,
  SchemaValidationError,
} from "@polaris/business-core";
import { TOOL_SCHEMAS_DIR } from "./paths.js";
import {
  CatalogError,
  type CatalogInput,
  type CatalogOutput,
  type CatalogSnapshot,
  type ContentProductionInput,
  type ContentProductionOutput,
} from "./types.js";
import { isCatalogInput, isContentProductionInput } from "./content-map.js";

const CATALOG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

function loadSchema(name: string): Schema {
  const candidates = [
    path.join(TOOL_SCHEMAS_DIR, name),
    path.join(SCHEMAS_DIR, name),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, "utf-8")) as Schema;
    }
  }
  throw new CatalogError(`schema not found: ${name}`, 1);
}

function validateAgainst(name: string, data: JsonObject, label: string): JsonObject {
  try {
    return validateJsonObject(data, loadSchema(name), label);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new CatalogError(`${label}: ${error.message}`, 2);
    }
    throw error;
  }
}

export function assertCatalogId(catalogId: string): void {
  if (!CATALOG_ID_PATTERN.test(catalogId)) {
    throw new CatalogError(
      `catalog_id must match ${CATALOG_ID_PATTERN}: got ${JSON.stringify(catalogId)}`,
      2,
    );
  }
}

export function parseCatalogInput(data: unknown): CatalogInput {
  if (!isJsonObject(data as JsonObject)) {
    throw new CatalogError("catalog input root must be an object", 2);
  }
  const validated = validateAgainst(
    "wanghai.promo.catalog-input.v1.schema.json",
    data as JsonObject,
    "catalog-input",
  );
  assertCatalogId(String(validated.catalog_id));
  const selection = validated.selection as CatalogInput["selection"];
  if (selection.mode === "explicit" && (!selection.product_ids || selection.product_ids.length === 0)) {
    throw new CatalogError("selection.mode=explicit requires non-empty product_ids", 2);
  }
  if (selection.mode === "batch" && !selection.batch) {
    throw new CatalogError("selection.mode=batch requires selection.batch", 2);
  }
  if (selection.mode === "external" && (selection.product_ids.length > 0 || selection.batch !== null)) {
    throw new CatalogError("selection.mode=external requires empty product_ids and batch=null", 2);
  }
  if (validated.brand && (validated.brand as CatalogInput["brand"]).logo_path) {
    // path safety checked at resolve time against workspace
  }
  return validated as unknown as CatalogInput;
}

export function parseCatalogSnapshot(data: unknown): CatalogSnapshot {
  if (!isJsonObject(data as JsonObject)) {
    throw new CatalogError("catalog snapshot root must be an object", 2);
  }
  validateAgainst(
    "wanghai.promo.catalog-snapshot.v1.schema.json",
    data as JsonObject,
    "catalog-snapshot",
  );
  return data as CatalogSnapshot;
}

export function parseCatalogOutput(data: unknown): CatalogOutput {
  if (!isJsonObject(data as JsonObject)) {
    throw new CatalogError("catalog output root must be an object", 2);
  }
  validateAgainst(
    "wanghai.promo.catalog-output.v1.schema.json",
    data as JsonObject,
    "catalog-output",
  );
  return data as CatalogOutput;
}

export function readJson(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    throw new CatalogError(`file not found: ${filePath}`, 2);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
}

export function assertJobId(jobId: string): void {
  assertCatalogId(jobId);
}

export function parseContentProductionInput(data: unknown): ContentProductionInput {
  if (!isJsonObject(data as JsonObject)) {
    throw new CatalogError("content-production input root must be an object", 2);
  }
  const validated = validateAgainst(
    "wanghai.content-production.input.v1.schema.json",
    data as JsonObject,
    "content-production-input",
  );
  assertJobId(String(validated.job_id));
  const input = validated as unknown as ContentProductionInput;
  if (input.content_kind === "product-catalog" && !input.kind_config.product_catalog) {
    throw new CatalogError(
      "kind_config.product_catalog required when content_kind=product-catalog",
      2,
    );
  }
  const selection = input.product_selection;
  if (selection.mode === "explicit" && (!selection.product_ids || selection.product_ids.length === 0)) {
    throw new CatalogError("product_selection.mode=explicit requires non-empty product_ids", 2);
  }
  if (selection.mode === "batch" && !selection.batch) {
    throw new CatalogError("product_selection.mode=batch requires batch", 2);
  }
  if (selection.mode === "external" && (selection.product_ids.length > 0 || selection.batch !== null)) {
    throw new CatalogError("product_selection.mode=external requires empty product_ids and batch=null", 2);
  }
  return input;
}

export function parseContentProductionOutput(data: unknown): ContentProductionOutput {
  if (!isJsonObject(data as JsonObject)) {
    throw new CatalogError("content-production output root must be an object", 2);
  }
  validateAgainst(
    "wanghai.content-production.output.v1.schema.json",
    data as JsonObject,
    "content-production-output",
  );
  return data as ContentProductionOutput;
}

/**
 * Accept either umbrella content-production input or legacy catalog-input.
 * Returns a tagged union for the runner.
 */
export function parseAnyJobInput(
  data: unknown,
):
  | { kind: "content"; input: ContentProductionInput }
  | { kind: "catalog"; input: CatalogInput } {
  if (isContentProductionInput(data)) {
    return { kind: "content", input: parseContentProductionInput(data) };
  }
  if (isCatalogInput(data) || (isJsonObject(data as JsonObject) && "catalog_id" in (data as object))) {
    return { kind: "catalog", input: parseCatalogInput(data) };
  }
  throw new CatalogError(
    "input must be wanghai.content-production.input.v1 or wanghai.promo.catalog-input",
    2,
  );
}
