import posthog from "posthog-js";
import * as Sentry from "@sentry/react";

type EnvMap = Record<string, string | undefined>;

const env = (import.meta as ImportMeta & { env?: EnvMap }).env ?? {};
const TELEMETRY_SCHEMA_VERSION = "1";
const SESSION_ID = crypto.randomUUID();

function readStoredInstallId(): string {
  const key = "polaris_install_id";
  const existing = window.localStorage.getItem(key)?.trim();
  if (existing) {
    return existing;
  }
  const next = crypto.randomUUID();
  window.localStorage.setItem(key, next);
  return next;
}

function appVersion(): string {
  return env.VITE_POLARIS_APP_VERSION?.trim() || "0.2.7";
}

export function resolveBrowserTelemetryEnabled(sourceEnv: EnvMap = env): boolean {
  const raw = sourceEnv.VITE_POLARIS_TELEMETRY_ENABLED?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") {
    return false;
  }
  return Boolean(sourceEnv.VITE_POLARIS_POSTHOG_KEY?.trim() || sourceEnv.VITE_POLARIS_SENTRY_DSN?.trim());
}

function telemetryEnabled(): boolean {
  return resolveBrowserTelemetryEnabled(env);
}

export function buildBrowserTelemetryCommonProperties(input: {
  installId: string;
  sessionId: string;
  locale: string;
  platform: string;
  sourceEnv?: EnvMap;
}): Record<string, unknown> {
  const sourceEnv = input.sourceEnv ?? env;
  return {
    install_id: input.installId,
    session_id: input.sessionId,
    app_version: sourceEnv.VITE_POLARIS_APP_VERSION?.trim() || "0.2.7",
    release_channel: sourceEnv.VITE_POLARIS_RELEASE_CHANNEL?.trim() || "stable",
    platform: input.platform,
    arch: "browser",
    entry_surface: "web",
    locale: input.locale,
    telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
  };
}

function commonProperties(): Record<string, unknown> {
  return buildBrowserTelemetryCommonProperties({
    installId: readStoredInstallId(),
    sessionId: SESSION_ID,
    locale: navigator.language,
    platform: navigator.platform,
    sourceEnv: env,
  });
}

export function initTelemetry(): void {
  if (!telemetryEnabled()) {
    return;
  }
  const posthogKey = env.VITE_POLARIS_POSTHOG_KEY?.trim();
  if (posthogKey) {
    posthog.init(posthogKey, {
      api_host: env.VITE_POLARIS_POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
      capture_pageview: false,
      capture_pageleave: true,
      autocapture: false,
      persistence: "localStorage+cookie",
    });
  }
  const sentryDsn = env.VITE_POLARIS_SENTRY_DSN?.trim();
  if (sentryDsn) {
    Sentry.init({
      dsn: sentryDsn,
      release: appVersion(),
      environment: env.VITE_POLARIS_SENTRY_ENVIRONMENT?.trim()
        || env.MODE
        || "production",
      tracesSampleRate: 0,
    });
  }
  window.addEventListener("error", (event) => {
    captureTelemetryError(event.error ?? new Error(event.message), {
      event: "unhandled_exception",
      error_domain: "browser",
      error_stage: "window.error",
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    captureTelemetryError(event.reason, {
      event: "unhandled_rejection",
      error_domain: "browser",
      error_stage: "window.unhandledrejection",
    });
  });
}

export function identifyTelemetryUser(input: {
  polarisUserId?: string | null;
  role?: string | null;
  plan?: string | null;
}): void {
  if (!telemetryEnabled()) {
    return;
  }
  const distinctId = input.polarisUserId?.trim() || readStoredInstallId();
  posthog.identify(distinctId, {
    role: input.role ?? null,
    plan: input.plan ?? null,
    app_version: appVersion(),
  });
  Sentry.setUser({
    id: distinctId,
  });
}

export function trackTelemetryEvent(
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (!telemetryEnabled()) {
    return;
  }
  posthog.capture(event, {
    ...commonProperties(),
    ...(properties ?? {}),
  });
}

export function captureTelemetryError(
  error: unknown,
  properties?: Record<string, unknown>,
): void {
  trackTelemetryEvent(properties?.event ? String(properties.event) : "error", {
    ...properties,
    error_name: error instanceof Error ? error.name : typeof error,
    sanitized_message: error instanceof Error ? error.message : String(error),
  });
  Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
    extra: {
      ...commonProperties(),
      ...(properties ?? {}),
    },
  });
}
