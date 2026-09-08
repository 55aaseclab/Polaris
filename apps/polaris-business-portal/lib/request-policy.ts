export const DEFAULT_JSON_BODY_BYTES = 1_048_576;
export const DEFAULT_UPLOAD_BODY_BYTES = 25 * 1024 * 1024;
export const DEFAULT_ASSET_RESPONSE_BYTES = 50 * 1024 * 1024;

export const MAX_JSON_BODY_BYTES = configuredByteLimit(
  "POLARIS_BUSINESS_MAX_JSON_BODY_BYTES",
  DEFAULT_JSON_BODY_BYTES,
);
export const MAX_UPLOAD_BODY_BYTES = configuredByteLimit(
  "POLARIS_BUSINESS_MAX_UPLOAD_BYTES",
  DEFAULT_UPLOAD_BODY_BYTES,
);
export const MAX_ASSET_RESPONSE_BYTES = configuredByteLimit(
  "POLARIS_BUSINESS_MAX_ASSET_RESPONSE_BYTES",
  DEFAULT_ASSET_RESPONSE_BYTES,
);

export class RequestPolicyError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 413 | 415,
  ) {
    super(message);
    this.name = "RequestPolicyError";
  }
}

export async function readJsonBody<T = unknown>(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<T> {
  const bytes = await readBoundedBody(request, maxBytes);
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new RequestPolicyError("Request body must use valid UTF-8", 400);
  }
  if (!raw) {
    throw new RequestPolicyError("Request body must contain JSON", 400);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new RequestPolicyError("Request body is not valid JSON", 400);
  }
}

export async function readJsonObject(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const value = await readJsonBody<unknown>(request, maxBytes);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestPolicyError("Request body must be a JSON object", 400);
  }
  return value as Record<string, unknown>;
}

export async function readFormData(
  request: Request,
  maxBytes = MAX_UPLOAD_BODY_BYTES,
): Promise<FormData> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data;")) {
    throw new RequestPolicyError("A multipart form body is required", 415);
  }

  const bytes = await readBoundedBody(request, maxBytes);
  const headers = new Headers(request.headers);
  // The original length describes the incoming stream, not this bounded copy.
  headers.delete("content-length");
  try {
    return await new Request(request.url, {
      method: request.method,
      headers,
      body: bytes as BodyInit,
    }).formData();
  } catch {
    throw new RequestPolicyError("Request body is not valid multipart form data", 400);
  }
}

export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Request body limit must be a positive safe integer");
  }
  validateDeclaredLength(request, maxBytes);

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      size += chunk.byteLength;
      if (size > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The stream may already have been closed by the runtime.
        }
        throw new RequestPolicyError(
          `Request body exceeds the ${maxBytes} byte limit`,
          413,
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function validateDeclaredLength(request: Request, maxBytes: number): void {
  const raw = request.headers.get("content-length");
  if (raw === null) return;
  if (!/^\d+$/u.test(raw.trim())) {
    throw new RequestPolicyError("Content-Length must be a non-negative integer", 400);
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) {
    throw new RequestPolicyError("Content-Length is invalid", 400);
  }
  if (length > maxBytes) {
    throw new RequestPolicyError(
      `Request body exceeds the ${maxBytes} byte limit`,
      413,
    );
  }
}

function configuredByteLimit(name: string, fallback: number): number {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive byte count`);
  }
  return value;
}
