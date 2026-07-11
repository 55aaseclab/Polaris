/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_POLARIS_APP_VERSION?: string;
  readonly VITE_POLARIS_RELEASE_CHANNEL?: string;
  readonly VITE_POLARIS_TELEMETRY_ENABLED?: string;
  readonly VITE_POLARIS_POSTHOG_KEY?: string;
  readonly VITE_POLARIS_POSTHOG_HOST?: string;
  readonly VITE_POLARIS_SENTRY_DSN?: string;
  readonly VITE_POLARIS_SENTRY_ENVIRONMENT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
