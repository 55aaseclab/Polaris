import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as Sentry from "@sentry/node";
import { PostHog } from "posthog-node";
import type { TelemetryContext, TelemetryEvent } from "./schema.js";
import { resolvePolarisAppVersion } from "./version.js";
import { logWarn } from "../utils/log.js";

let posthogClient: PostHog | null = null;
let sentryInitialized = false;
let contextCache: TelemetryContext | null = null;

export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.POLARIS_TELEMETRY_ENABLED?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") {
    return false;
  }
  return Boolean(env.POLARIS_POSTHOG_API_KEY?.trim() || env.POLARIS_SENTRY_DSN?.trim());
}

export function telemetryRoot(env: NodeJS.ProcessEnv = process.env): string {
  const dataRoot = env.POLARIS_DATA_ROOT?.trim()
    || env.POLARIS_LOCAL_DEPLOY_DATA_ROOT?.trim()
    || path.join(os.homedir(), ".local", "share", "polaris");
  return path.isAbsolute(dataRoot) ? dataRoot : path.resolve(dataRoot);
}

function readOrCreateId(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8").trim();
    if (existing) {
      return existing;
    }
  }
  const next = crypto.randomUUID();
  fs.writeFileSync(filePath, `${next}\n`, "utf8");
  return next;
}

function resolveContext(importMetaUrl: string): TelemetryContext {
  if (contextCache) {
    return contextCache;
  }
  const root = telemetryRoot();
  const contextDir = path.join(root, "state", "telemetry");
  const installId = readOrCreateId(path.join(contextDir, "install-id"));
  const sessionId = crypto.randomUUID();
  contextCache = {
    installId,
    sessionId,
    appVersion: resolvePolarisAppVersion(importMetaUrl),
    releaseChannel: process.env.POLARIS_RELEASE_CHANNEL?.trim() || "stable",
    platform: process.platform,
    arch: process.arch,
    entrySurface: process.env.POLARIS_TELEMETRY_ENTRY_SURFACE?.trim() || "node",
    environment: process.env.POLARIS_TELEMETRY_ENVIRONMENT?.trim()
      || process.env.NODE_ENV?.trim()
      || "production",
    telemetrySchemaVersion: "1",
  };
  return contextCache;
}

function posthog(importMetaUrl: string): PostHog | null {
  if (!telemetryEnabled()) {
    return null;
  }
  if (posthogClient) {
    return posthogClient;
  }
  const apiKey = process.env.POLARIS_POSTHOG_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  posthogClient = new PostHog(apiKey, {
    host: process.env.POLARIS_POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
    flushAt: 1,
    flushInterval: 0,
  });
  return posthogClient;
}

function initSentry(importMetaUrl: string): void {
  if (sentryInitialized || !telemetryEnabled()) {
    return;
  }
  const dsn = process.env.POLARIS_SENTRY_DSN?.trim();
  if (!dsn) {
    return;
  }
  const context = resolveContext(importMetaUrl);
  Sentry.init({
    dsn,
    environment: process.env.POLARIS_SENTRY_ENVIRONMENT?.trim() || context.environment,
    release: context.appVersion,
    tracesSampleRate: 0,
  });
  sentryInitialized = true;
}

export function telemetryContext(importMetaUrl: string): TelemetryContext {
  return resolveContext(importMetaUrl);
}

export async function trackTelemetryEvent(
  importMetaUrl: string,
  input: TelemetryEvent,
): Promise<void> {
  if (!telemetryEnabled()) {
    return;
  }
  const client = posthog(importMetaUrl);
  if (!client) {
    return;
  }
  const context = resolveContext(importMetaUrl);
  try {
    client.capture({
      distinctId: context.installId,
      event: input.event,
      properties: {
        ...context,
        category: input.category,
        timestamp: new Date().toISOString(),
        ...(input.properties ?? {}),
      },
    });
    await client.shutdown();
  } catch (error) {
    logWarn("telemetry", "posthog-capture-failed", {
      event: input.event,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    posthogClient = null;
  }
}

export async function captureTelemetryError(
  importMetaUrl: string,
  error: unknown,
  input: {
    event: string;
    category?: TelemetryEvent["category"];
    properties?: Record<string, unknown>;
  },
): Promise<void> {
  const category = input.category ?? "error";
  await trackTelemetryEvent(importMetaUrl, {
    event: input.event,
    category,
    properties: {
      error_name: error instanceof Error ? error.name : typeof error,
      sanitized_message: error instanceof Error ? error.message : String(error),
      ...(input.properties ?? {}),
    },
  });
  initSentry(importMetaUrl);
  if (sentryInitialized) {
    try {
      Sentry.withScope((scope) => {
        const context = resolveContext(importMetaUrl);
        scope.setTag("category", category);
        scope.setTag("entry_surface", context.entrySurface);
        scope.setUser({ id: context.installId });
        for (const [key, value] of Object.entries(input.properties ?? {})) {
          scope.setExtra(key, value);
        }
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
      });
    } catch (captureError) {
      logWarn("telemetry", "sentry-capture-failed", {
        event: input.event,
        message: captureError instanceof Error ? captureError.message : String(captureError),
      });
    }
  }
}

export function registerTelemetryProcessHandlers(importMetaUrl: string): void {
  initSentry(importMetaUrl);
  process.on("uncaughtException", (error) => {
    void captureTelemetryError(importMetaUrl, error, {
      event: "unhandled_exception",
      properties: {
        error_domain: "node",
        error_stage: "uncaughtException",
      },
    });
  });
  process.on("unhandledRejection", (error) => {
    void captureTelemetryError(importMetaUrl, error, {
      event: "unhandled_rejection",
      properties: {
        error_domain: "node",
        error_stage: "unhandledRejection",
      },
    });
  });
}
