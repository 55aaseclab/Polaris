export type TimelineScalar = string | number | boolean;

export type TimelineValue =
  | { kind: "file"; label: string; path: string }
  | { kind: "scalar"; text: string; tone: "string" | "number" | "boolean" | "plain" };

export type TimelineField = {
  key: string;
  value: TimelineValue;
};

export type TimelineCallBlock = {
  call?: string;
  uses: TimelineField[];
  outputs: TimelineField[];
  note?: string;
};

const WORKSPACE_MARKER = "/.polaris/workflow-workspaces/";

export function workspaceRelativePath(runId: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const marker = `/${runId}/`;
  const fromRun = trimmed.indexOf(marker);
  if (fromRun >= 0) return trimmed.slice(fromRun + marker.length);
  const fromWorkspace = trimmed.indexOf(WORKSPACE_MARKER);
  if (fromWorkspace >= 0) {
    const after = trimmed.slice(fromWorkspace + WORKSPACE_MARKER.length);
    const slash = after.indexOf("/");
    return slash >= 0 ? after.slice(slash + 1) : after;
  }
  if (!trimmed.startsWith("/") && trimmed.includes("/")) return trimmed;
  return null;
}

export function timelineValue(runId: string, value: unknown): TimelineValue {
  if (typeof value === "string") {
    const relative = workspaceRelativePath(runId, value);
    if (relative) return { kind: "file", label: relative, path: relative };
    return { kind: "scalar", text: value, tone: "string" };
  }
  if (typeof value === "number") return { kind: "scalar", text: String(value), tone: "number" };
  if (typeof value === "boolean") return { kind: "scalar", text: String(value), tone: "boolean" };
  if (value === null || value === undefined) return { kind: "scalar", text: "—", tone: "plain" };
  try {
    return { kind: "scalar", text: JSON.stringify(value), tone: "plain" };
  } catch {
    return { kind: "scalar", text: String(value), tone: "plain" };
  }
}

export function timelineFields(
  runId: string,
  record: Record<string, unknown> | undefined,
  preferred: string[] = [],
): TimelineField[] {
  const output = record ?? {};
  const ordered = preferred.filter((field) => field.trim()).length
    ? preferred.filter((field) => field.trim())
    : Object.keys(output);
  const emitted = new Set<string>();
  const fields: TimelineField[] = [];
  for (const key of ordered) {
    emitted.add(key);
    fields.push({ key, value: timelineValue(runId, output[key]) });
  }
  for (const [key, value] of Object.entries(output)) {
    if (emitted.has(key)) continue;
    fields.push({ key, value: timelineValue(runId, value) });
  }
  return fields;
}

export function resumedNote(detail: string): string | undefined {
  const match = detail.match(/\bresumed\s+\S+/u);
  return match?.[0];
}

export function timelineCallBlock(input: {
  runId: string;
  call?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  outputFields?: string[];
  detail?: string;
}): TimelineCallBlock | null {
  const uses = timelineFields(input.runId, input.input);
  const outputs = timelineFields(input.runId, input.output, input.outputFields);
  const note = input.detail ? resumedNote(input.detail) : undefined;
  if (!input.call && uses.length === 0 && outputs.length === 0 && !note) return null;
  return {
    ...(input.call ? { call: input.call } : {}),
    uses,
    outputs,
    ...(note ? { note } : {}),
  };
}

export function artifactPreviewPage(runId: string, artifactId: string): string {
  return `/work/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

export function workspaceFilePage(runId: string, relativePath: string): string {
  return `/work/runs/${encodeURIComponent(runId)}/files/${relativePath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/")}`;
}

export function workspaceFileUrl(runId: string, relativePath: string): string {
  return `/api/workflow-runs/${encodeURIComponent(runId)}/files?path=${encodeURIComponent(relativePath)}`;
}

export function pathLabelParts(path: string): string[] {
  return path.split("/");
}
