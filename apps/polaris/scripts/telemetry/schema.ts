export type TelemetryCategory =
  | "distribution"
  | "environment"
  | "runtime"
  | "product"
  | "error";

export interface TelemetryEvent {
  event: string;
  category: TelemetryCategory;
  properties?: Record<string, unknown>;
}

export interface TelemetryContext {
  installId: string;
  sessionId: string;
  appVersion: string;
  releaseChannel: string;
  platform: NodeJS.Platform | string;
  arch: string;
  entrySurface: string;
  environment: string;
  telemetrySchemaVersion: string;
}
