type WorkspaceWorkflowEditableField = {
  path: string;
  value: string;
};

type ConfigRecord = Record<string, unknown>;
const TEMPLATE = /{{([a-z][a-z0-9_]*)}}/g;

function isRecord(value: unknown): value is ConfigRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatEditableValue(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return JSON.stringify(value);
}

function interpolateString(
  value: string,
  variables: Record<string, string>,
): string {
  return value.replace(TEMPLATE, (match, name: string) => variables[name] ?? match);
}

function resolveEditableValue(
  value: unknown,
  variables: Record<string, string>,
): unknown {
  if (typeof value === "string") return interpolateString(value, variables);
  if (Array.isArray(value)) return value.map((item) => resolveEditableValue(item, variables));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveEditableValue(item, variables)]),
    );
  }
  return value;
}

function isStepPath(prefix: string): boolean {
  return prefix === "steps" || prefix.startsWith("steps[");
}

export function flattenEditableFields(
  value: unknown,
  prefix = "",
  variables: Record<string, string> = {},
): WorkspaceWorkflowEditableField[] {
  if (Array.isArray(value)) {
    if (!prefix) return [];
    if (!isStepPath(prefix)) {
      return [{ path: prefix, value: JSON.stringify(resolveEditableValue(value, variables)) }];
    }
    return value.flatMap((item, index) => (
      flattenEditableFields(item, `${prefix}[${index + 1}]`, variables)
    ));
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, child]) => {
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      return flattenEditableFields(child, childPrefix, variables);
    });
  }
  if (!prefix) return [];
  return [{ path: prefix, value: formatEditableValue(resolveEditableValue(value, variables)) }];
}
