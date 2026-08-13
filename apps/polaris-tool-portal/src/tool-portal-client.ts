import type {
  PolarisToolPortalCatalogRow,
} from "polaris-tools/source";

export interface ToolPortalCatalogResponse {
  tools: PolarisToolPortalCatalogRow[];
}

export interface ToolPortalRequestError extends Error {
  status: number;
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`/api/tool-portal${path}`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      typeof body.error === "string" ? body.error : `Request failed (${response.status})`,
    ) as ToolPortalRequestError;
    error.status = response.status;
    throw error;
  }
  return body as T;
}

export function isToolPortalRequestError(value: unknown): value is ToolPortalRequestError {
  return value instanceof Error && typeof (value as Partial<ToolPortalRequestError>).status === "number";
}

export async function readToolPortalCatalog(): Promise<ToolPortalCatalogResponse> {
  return request<ToolPortalCatalogResponse>("/catalog");
}
