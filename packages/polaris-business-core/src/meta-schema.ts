import fs from "node:fs";
import path from "node:path";
import { SCHEMAS_DIR } from "./repo.js";
import { type JsonObject, type JsonValue, isJsonObject } from "./json.js";
import { SchemaValidationError, type Schema, validateJsonObject } from "./schema-validation.js";

export class MetaSchemaError extends SchemaValidationError {}

const META_SCHEMA_PATH = path.join(SCHEMAS_DIR, "wanghai.promo.product-meta.v5.schema.json");

let cachedSchema: Schema | null = null;

export function productMetaSchemaPath(): string {
  return META_SCHEMA_PATH;
}

export function loadProductMetaSchema(): Schema {
  if (cachedSchema) return cachedSchema;
  cachedSchema = JSON.parse(fs.readFileSync(META_SCHEMA_PATH, "utf-8")) as Schema;
  return cachedSchema;
}

export function validateProductMeta(data: JsonObject, metaPath?: string): JsonObject {
  const prefix = metaPath ? `${metaPath}: ` : "";
  try {
    return validateJsonObject(data, loadProductMetaSchema(), "meta.json schema v5");
  } catch (error) {
    if (error instanceof SchemaValidationError) throw new MetaSchemaError(`${prefix}${error.message}`);
    throw error;
  }
}

export function readAndValidateProductMeta(metaPath: string): JsonObject {
  const data = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as JsonValue;
  if (!isJsonObject(data)) throw new MetaSchemaError(`${metaPath}: meta.json root must be an object`);
  return validateProductMeta(data, metaPath);
}
