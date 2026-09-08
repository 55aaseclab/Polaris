import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  resolveWorkspacePath,
  safeWorkspacePath,
  STANDARD_MODULES,
  WorkspacePaths,
  workspaceRelativePath,
} from "@polaris/business-core/workspaces";
import { WorkspaceVersionConflictError } from "@polaris/business-core/workspace-version";
import { WanghaiGatewayAuthError } from "@/lib/gateway-auth";
import { mutateAdmittedWorkspace } from "@/lib/workspace-mutation";
import {
  assertWanghaiFormMutationAdmission,
  assertWanghaiJsonMutationAdmission,
} from "@/lib/mutation-admission";
import {
  MAX_ASSET_RESPONSE_BYTES,
  MAX_JSON_BODY_BYTES,
  MAX_UPLOAD_BODY_BYTES,
  RequestPolicyError,
  readFormData as readFormDataWithPolicy,
  readJsonBody,
  readJsonObject as readJsonObjectWithPolicy,
} from "@/lib/request-policy";

export type RouteContext<T extends Record<string, string> = Record<string, string>> = {
  params: Promise<T>;
};

export function jsonError(message: string, status = 400) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export function requestError(error: unknown, fallbackStatus = 400) {
  if (error instanceof WorkspaceVersionConflictError) {
    return NextResponse.json(
      {
        error: error.message,
        ...(error.currentVersion === undefined
          ? {}
          : { workspace_version: error.currentVersion }),
      },
      { status: error.statusCode, headers: { "cache-control": "no-store" } },
    );
  }
  const status = error instanceof RequestPolicyError
    || error instanceof WanghaiGatewayAuthError
    ? error.statusCode
    : fallbackStatus;
  return jsonError(error instanceof Error ? error.message : String(error), status);
}

export {
  MAX_ASSET_RESPONSE_BYTES,
  MAX_JSON_BODY_BYTES,
  MAX_UPLOAD_BODY_BYTES,
  readJsonBody,
};

export async function readJsonObject(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const body = await readJsonObjectWithPolicy(request, maxBytes);
  await assertWanghaiJsonMutationAdmission(request, body);
  return body;
}

export async function readFormData(
  request: Request,
  maxBytes = MAX_UPLOAD_BODY_BYTES,
): Promise<FormData> {
  await assertWanghaiFormMutationAdmission(request);
  return readFormDataWithPolicy(request, maxBytes);
}

export async function routeParams<T extends Record<string, string>>(context: RouteContext<T>): Promise<T> {
  return context.params;
}

export async function workspaceFromContext(context: RouteContext<{ workspace: string }>): Promise<{ name: string; root: string; paths: WorkspacePaths }> {
  const { workspace } = await routeParams(context);
  const name = decodeURIComponent(workspace);
  const root = resolveWorkspacePath(name);
  return { name, root, paths: new WorkspacePaths(root) };
}

export async function mutateWorkspace<T>(input: {
  mutate: () => Promise<T> | T;
  request: Request;
  workspace: string;
  workspaceRoot: string;
}) {
  return mutateAdmittedWorkspace({
    ...input,
    mutate: () => input.mutate(),
  });
}

export function workspaceMutationJson(
  payload: object,
  workspaceVersion: number,
  init?: ResponseInit,
): NextResponse {
  const response = NextResponse.json(
    { ...payload, workspace_version: workspaceVersion },
    init,
  );
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-polaris-workspace-version", String(workspaceVersion));
  return response;
}

export function fileSummary(filePath: string, workspaceRoot: string) {
  const stat = fs.statSync(filePath);
  return {
    name: path.basename(filePath),
    path: workspaceRelativePath(workspaceRoot, filePath),
    size: stat.size,
    modified_at: stat.mtime.toISOString(),
  };
}

export function moduleSummary(workspaceRoot: string) {
  const paths = new WorkspacePaths(workspaceRoot);
  return STANDARD_MODULES.map((name) => {
    const dir = paths.moduleDir(name);
    const exists = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    const entries = exists ? fs.readdirSync(dir, { withFileTypes: true }) : [];
    return {
      name,
      exists,
      path: exists ? workspaceRelativePath(workspaceRoot, dir) : "",
      file_count: entries.filter((entry) => entry.isFile()).length,
      folder_count: entries.filter((entry) => entry.isDirectory()).length,
    };
  });
}

export function listFilesRecursive(rootDir: string, workspaceRoot: string, limit = 80) {
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) return [];
  const files: ReturnType<typeof fileSummary>[] = [];
  const stack = [rootDir];
  while (stack.length > 0 && files.length < limit) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const itemPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(itemPath);
      else if (entry.isFile()) files.push(fileSummary(itemPath, workspaceRoot));
      if (files.length >= limit) break;
    }
  }
  return files;
}

export function safeAssetPath(workspaceRoot: string, value: string): string {
  return safeWorkspacePath(workspaceRoot, value);
}
