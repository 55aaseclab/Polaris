import { NextResponse } from "next/server";
import { defaultSubmoduleMeta, readSubmoduleMeta, writeSubmoduleMeta } from "@polaris/business-core/operations";
import { generateTradeDocument } from "@polaris/business-core/trade-documents";
import {
  mutateWorkspace,
  readJsonObject,
  requestError,
  routeParams,
  workspaceMutationJson,
  workspaceFromContext,
  type RouteContext,
} from "../../../../../../_lib";

const KINDS = new Set(["quotes", "inspections", "payments", "shipments", "invoices", "reconciliations", "archives", "attachments"]);

function assertKind(value: string) {
  if (!KINDS.has(value)) throw new Error(`Unsupported order submodule kind: ${value}`);
  return value as "quotes" | "inspections" | "payments" | "shipments" | "invoices" | "reconciliations" | "archives" | "attachments";
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function GET(_request: Request, context: RouteContext<{ workspace: string; orderNo: string; kind: string }>) {
  try {
    const { name, root } = await workspaceFromContext(context);
    const { orderNo, kind } = await routeParams(context);
    const record = readSubmoduleMeta(root, decodeURIComponent(orderNo), assertKind(kind));
    return NextResponse.json({ record: record ?? defaultSubmoduleMeta(assertKind(kind), decodeURIComponent(orderNo)) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function POST(request: Request, context: RouteContext<{ workspace: string; orderNo: string; kind: string }>) {
  try {
    const { name, root } = await workspaceFromContext(context);
    const { orderNo, kind } = await routeParams(context);
    const payload = await readJsonObject(request);
    const resolvedKind = assertKind(kind);
    const current = readSubmoduleMeta(root, decodeURIComponent(orderNo), resolvedKind) ?? defaultSubmoduleMeta(resolvedKind, decodeURIComponent(orderNo));
    if (payload?.action === "generate_document") {
      if (resolvedKind !== "quotes" && resolvedKind !== "invoices") {
        return NextResponse.json({ error: "Document generation is only supported for quotes and invoices" }, { status: 400 });
      }
      const merged = {
        ...current,
        ...optionalRecord(payload.record),
        order_no: decodeURIComponent(orderNo),
      };
      const mutation = await mutateWorkspace({
        request,
        workspace: name,
        workspaceRoot: root,
        mutate: () => generateTradeDocument(root, decodeURIComponent(orderNo), resolvedKind, merged),
      });
      return workspaceMutationJson({
        record: mutation.result.record,
        document_path: mutation.result.relativePath,
      }, mutation.workspaceVersion);
    }
    const mutation = await mutateWorkspace({
      request,
      workspace: name,
      workspaceRoot: root,
      mutate: () => writeSubmoduleMeta(
        root,
        decodeURIComponent(orderNo),
        resolvedKind,
        { ...current, ...payload, order_no: decodeURIComponent(orderNo) },
      ),
    });
    return workspaceMutationJson({ record: mutation.result }, mutation.workspaceVersion);
  } catch (error) {
    return requestError(error);
  }
}
