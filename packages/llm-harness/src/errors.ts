/** Stable error codes thrown by every CLH failure path. */
export type ClhErrorCode =
  | "CLH_PRESET_INVALID"
  | "CLH_PRESET_UNKNOWN_FIELD"
  | "CLH_PRESET_MISSING_FIELD"
  | "CLH_PRESET_KIND_CONFLICT"
  | "CLH_MISSING_CREDENTIAL"
  | "CLH_MISSING_MODEL"
  | "CLH_ENDPOINT_INVALID"
  | "CLH_API_STATUS"
  | "CLH_API_TIMEOUT"
  | "CLH_OUTPUT_CONTRACT"
  | "CLH_SESSION_LOG_UNAVAILABLE"
  | "CLH_DSH_NOT_FOUND"
  | "CLH_DSH_EXIT"
  | "CLH_DISPATCHER_URL_MISSING";

export class ClhError extends Error {
  readonly code: ClhErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ClhErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ClhError";
    this.code = code;
    this.details = details;
  }
}

export function isClhError(value: unknown): value is ClhError {
  return value instanceof ClhError;
}
