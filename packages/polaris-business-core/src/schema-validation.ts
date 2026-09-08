import { type JsonObject, type JsonValue, isJsonObject } from "./json.js";

export type Schema = {
  type?: string | string[];
  const?: JsonValue;
  enum?: JsonValue[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  minProperties?: number;
  minLength?: number;
  minimum?: number;
  items?: Schema;
};

export class SchemaValidationError extends Error {}

function jsonType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function sameValue(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function validateJsonValue(value: JsonValue, schema: Schema, pointer: string, label: string): void {
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = jsonType(value);
    const integerMatch = allowed.includes("integer") && typeof value === "number" && Number.isInteger(value);
    if (!allowed.includes(actual) && !integerMatch) {
      throw new SchemaValidationError(`${label} does not match schema at ${pointer}: expected ${allowed.join(" | ")}, got ${actual}`);
    }
    // Nullable schemas may also declare object shape; null is valid and done.
    if (value === null && allowed.includes("null")) {
      return;
    }
  }

  if (schema.const !== undefined && !sameValue(value, schema.const)) {
    throw new SchemaValidationError(`${label} does not match schema at ${pointer}: expected constant ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum && !schema.enum.some((item) => sameValue(item, value))) {
    throw new SchemaValidationError(`${label} does not match schema at ${pointer}: value ${JSON.stringify(value)} is not in enum`);
  }

  if (schema.minLength !== undefined && typeof value === "string" && value.length < schema.minLength) {
    throw new SchemaValidationError(`${label} does not match schema at ${pointer}: string is shorter than ${schema.minLength}`);
  }

  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    throw new SchemaValidationError(`${label} does not match schema at ${pointer}: number is smaller than ${schema.minimum}`);
  }

  if (schema.items) {
    if (!Array.isArray(value)) {
      throw new SchemaValidationError(`${label} does not match schema at ${pointer}: expected array`);
    }
    value.forEach((item, index) => validateJsonValue(item, schema.items as Schema, `${pointer}.${index}`, label));
  }

  if (schema.required || schema.properties || schema.additionalProperties !== undefined || schema.minProperties !== undefined) {
    if (!isJsonObject(value)) {
      throw new SchemaValidationError(`${label} does not match schema at ${pointer}: expected object`);
    }

    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      throw new SchemaValidationError(`${label} does not match schema at ${pointer}: object has fewer than ${schema.minProperties} properties`);
    }

    for (const key of schema.required ?? []) {
      if (!(key in value)) {
        throw new SchemaValidationError(`${label} does not match schema at ${pointer}: missing required property ${key}`);
      }
    }

    const propertySchemas = schema.properties ?? {};
    for (const [key, child] of Object.entries(propertySchemas)) {
      if (key in value) validateJsonValue(value[key] as JsonValue, child, `${pointer}.${key}`, label);
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in propertySchemas)) {
          throw new SchemaValidationError(`${label} does not match schema at ${pointer}: unexpected property ${key}`);
        }
      }
    } else if (isJsonObject(schema.additionalProperties as JsonValue)) {
      for (const [key, childValue] of Object.entries(value)) {
        if (key in propertySchemas) continue;
        validateJsonValue(childValue, schema.additionalProperties as Schema, `${pointer}.${key}`, label);
      }
    }
  }
}

export function validateJsonObject(data: JsonObject, schema: Schema, label: string): JsonObject {
  validateJsonValue(data, schema, "<root>", label);
  return data;
}
