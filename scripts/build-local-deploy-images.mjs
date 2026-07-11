import { execFileSync } from "node:child_process";

function run(command, args) {
  execFileSync(command, args, {
    stdio: "inherit",
  });
}

run("docker", [
  "build",
  "-f",
  "apps/polaris/Dockerfile",
  "-t",
  "polaris-local/polaris-control-plane:0.2.6",
  ".",
]);

run("docker", [
  "build",
  "-f",
  "apps/polaris-web/Dockerfile",
  "--build-arg",
  `VITE_POLARIS_APP_VERSION=${process.env.VITE_POLARIS_APP_VERSION || process.env.POLARIS_APP_VERSION || "0.2.6"}`,
  "--build-arg",
  `VITE_POLARIS_RELEASE_CHANNEL=${process.env.VITE_POLARIS_RELEASE_CHANNEL || process.env.POLARIS_RELEASE_CHANNEL || "stable"}`,
  "--build-arg",
  `VITE_POLARIS_TELEMETRY_ENABLED=${process.env.VITE_POLARIS_TELEMETRY_ENABLED || ""}`,
  "--build-arg",
  `VITE_POLARIS_POSTHOG_KEY=${process.env.VITE_POLARIS_POSTHOG_KEY || ""}`,
  "--build-arg",
  `VITE_POLARIS_POSTHOG_HOST=${process.env.VITE_POLARIS_POSTHOG_HOST || ""}`,
  "--build-arg",
  `VITE_POLARIS_SENTRY_DSN=${process.env.VITE_POLARIS_SENTRY_DSN || ""}`,
  "--build-arg",
  `VITE_POLARIS_SENTRY_ENVIRONMENT=${process.env.VITE_POLARIS_SENTRY_ENVIRONMENT || ""}`,
  "-t",
  "polaris-local/polaris-webportal:0.2.6",
  ".",
]);

run("docker", [
  "build",
  "-f",
  "apps/paseo/Dockerfile",
  "-t",
  "polaris-local/paseo-app:0.2.6",
  ".",
]);
