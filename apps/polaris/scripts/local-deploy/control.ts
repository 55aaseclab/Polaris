import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import type { LocalDeployAction, LocalDeployActionResult, LocalDeployConfig } from "./types.js";
import { ensureLocalDeployDirs, resolveLocalDeployConfig } from "./paths.js";
import { captureTelemetryError, telemetryContext, trackTelemetryEvent } from "../telemetry/client.js";

function dockerError(cause: string): Error {
  return new Error(`Docker is required for Polaris local deployment: ${cause}`);
}

function runCapture(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(result.error.message || `failed to execute ${command}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    throw new Error(stderr || stdout || `${command} ${args.join(" ")} failed`);
  }
  return String(result.stdout || "");
}

function runCompose(config: LocalDeployConfig, args: string[]): void {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      config.composeFile,
      "--project-name",
      config.projectName,
      "--env-file",
      config.envFile,
      ...args,
    ],
    {
      stdio: "inherit",
      encoding: "utf8",
    },
  );
  if (result.error) {
    throw new Error(result.error.message || "docker compose failed");
  }
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed (${result.status ?? 1})`);
  }
}

function captureCompose(config: LocalDeployConfig, args: string[]): string {
  return runCapture("docker", [
    "compose",
    "-f",
    config.composeFile,
    "--project-name",
    config.projectName,
    "--env-file",
    config.envFile,
    ...args,
  ]);
}

function ensureDockerAvailable(): void {
  try {
    runCapture("docker", ["--version"]);
  } catch (error) {
    throw dockerError(error instanceof Error ? error.message : String(error));
  }
  try {
    runCapture("docker", ["info", "--format", "{{.ServerVersion}}"]);
  } catch (error) {
    throw dockerError("Docker is installed but not running");
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function quoteEnvValue(value: string): string {
  return JSON.stringify(value);
}

function defaultExecutorSecret(): string {
  return crypto.randomBytes(24).toString("hex");
}

function buildEnvFile(config: LocalDeployConfig): string {
  const releaseManifest = fs.existsSync(config.releaseManifestPath)
    ? JSON.parse(fs.readFileSync(config.releaseManifestPath, "utf8")) as {
      images?: Record<string, string>;
    }
    : {};
  const existing = fs.existsSync(config.envFile)
    ? fs.readFileSync(config.envFile, "utf8")
    : "";
  const preserved = new Map<string, string>();
  for (const line of existing.split(/\r?\n/u)) {
    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key) {
      preserved.set(key, value);
    }
  }
  const secret = preserved.get("POLARIS_EXECUTOR_SHARED_SECRET")
    || quoteEnvValue(defaultExecutorSecret());
  const images = releaseManifest.images ?? {};
  const lines = [
    `POLARIS_DATA_ROOT=${quoteEnvValue(config.dataRoot)}`,
    `POLARIS_APP_VERSION=${quoteEnvValue(String((releaseManifest as { version?: string }).version || "unknown"))}`,
    `POLARIS_RELEASE_CHANNEL=${quoteEnvValue(String((releaseManifest as { releaseChannel?: string }).releaseChannel || "stable"))}`,
    `POLARIS_EXECUTOR_SHARED_SECRET=${secret}`,
    `POLARIS_TELEMETRY_ENABLED=${preserved.get("POLARIS_TELEMETRY_ENABLED") || "\"\""}`,
    `POLARIS_POSTHOG_API_KEY=${preserved.get("POLARIS_POSTHOG_API_KEY") || "\"\""}`,
    `POLARIS_POSTHOG_HOST=${preserved.get("POLARIS_POSTHOG_HOST") || "\"https://us.i.posthog.com\""}`,
    `POLARIS_SENTRY_DSN=${preserved.get("POLARIS_SENTRY_DSN") || "\"\""}`,
    `POLARIS_SENTRY_ENVIRONMENT=${preserved.get("POLARIS_SENTRY_ENVIRONMENT") || "\"\""}`,
    `POLARIS_TELEMETRY_ENVIRONMENT=${preserved.get("POLARIS_TELEMETRY_ENVIRONMENT") || "\"\""}`,
    `POLARIS_LOCAL_DEPLOY_PORT=${config.gatewayPort}`,
    `POLARIS_PASEO_APP_BASE_URL=${quoteEnvValue(config.gatewayUrl)}`,
    `POLARIS_LOCAL_DEPLOY_CONTROL_PLANE_IMAGE=${preserved.get("POLARIS_LOCAL_DEPLOY_CONTROL_PLANE_IMAGE") || quoteEnvValue(images.controlPlane || "polaris-local/polaris-control-plane:0.2.7")}`,
    `POLARIS_LOCAL_DEPLOY_PASEO_IMAGE=${preserved.get("POLARIS_LOCAL_DEPLOY_PASEO_IMAGE") || quoteEnvValue(images.paseoApp || "polaris-local/paseo-app:0.2.7")}`,
    `POLARIS_AUTHING_APP_ID=${preserved.get("POLARIS_AUTHING_APP_ID") || "\"\""}`,
    `POLARIS_AUTHING_APP_SECRET=${preserved.get("POLARIS_AUTHING_APP_SECRET") || "\"\""}`,
    `POLARIS_AUTHING_ISSUER=${preserved.get("POLARIS_AUTHING_ISSUER") || "\"\""}`,
    `POLARIS_AUTHING_JWKS_URL=${preserved.get("POLARIS_AUTHING_JWKS_URL") || "\"\""}`,
    `POLARIS_AUTHING_AUTHORIZATION_URL=${preserved.get("POLARIS_AUTHING_AUTHORIZATION_URL") || "\"\""}`,
    `POLARIS_AUTHING_TOKEN_URL=${preserved.get("POLARIS_AUTHING_TOKEN_URL") || "\"\""}`,
    `POLARIS_AUTHING_LOGOUT_URL=${preserved.get("POLARIS_AUTHING_LOGOUT_URL") || "\"\""}`,
    `POLARIS_AUTHING_LOGOUT_REDIRECT_URI=${preserved.get("POLARIS_AUTHING_LOGOUT_REDIRECT_URI") || quoteEnvValue(config.gatewayUrl)}`,
    `POLARIS_AUTHING_REDIRECT_URI=${preserved.get("POLARIS_AUTHING_REDIRECT_URI") || quoteEnvValue(`${config.gatewayUrl}/auth/callback`)}`,
    "",
  ];
  return lines.join("\n");
}

function ensureEnvFile(config: LocalDeployConfig): void {
  ensureLocalDeployDirs(config);
  if (!fs.existsSync(config.envFile)) {
    fs.writeFileSync(config.envFile, buildEnvFile(config), "utf8");
    return;
  }
  const next = buildEnvFile(config);
  fs.writeFileSync(config.envFile, next, "utf8");
}

function openUrl(url: string): void {
  const platform = process.platform;
  if (platform === "darwin") {
    runCapture("open", [url]);
    return;
  }
  if (platform === "win32") {
    spawnSync("cmd", ["/c", "start", "", url], {
      stdio: "ignore",
    });
    return;
  }
  runCapture("xdg-open", [url]);
}

export async function runLocalDeployAction(
  action: LocalDeployAction,
  importMetaUrl: string,
): Promise<LocalDeployActionResult> {
  const config = resolveLocalDeployConfig(importMetaUrl);
  const context = telemetryContext(importMetaUrl);
  const startedAt = Date.now();

  await trackTelemetryEvent(importMetaUrl, {
    event: action === "install" ? "installer_started" : action === "upgrade" ? "upgrade_started" : "control_action_started",
    category: action === "install" || action === "upgrade" ? "distribution" : "runtime",
    properties: {
      action,
      entry_surface: context.entrySurface,
      gateway_port: config.gatewayPort,
    },
  });

  try {
    if (action === "desktop") {
      return {
        action,
        message: "Desktop entry is handled by the dedicated desktop launcher command",
      };
    }

    ensureLocalDeployDirs(config);

    if (action === "install") {
      ensureDockerAvailable();
      await trackTelemetryEvent(importMetaUrl, {
        event: "docker_check_passed",
        category: "environment",
        properties: { action },
      });
      ensureEnvFile(config);
      const portFree = await isPortFree(config.gatewayPort);
      if (!portFree) {
        throw new Error(`Local deployment port ${config.gatewayPort} is already in use`);
      }
      const result = {
        action,
        message: `Polaris local deployment is initialized at ${config.dataRoot}`,
        details: [
          `env: ${config.envFile}`,
          `url: ${config.gatewayUrl}`,
        ],
      };
      await trackTelemetryEvent(importMetaUrl, {
        event: "installer_completed",
        category: "distribution",
        properties: {
          action,
          duration_ms: Date.now() - startedAt,
          data_root_configured: true,
        },
      });
      return result;
    }

    if (action === "doctor") {
      ensureEnvFile(config);
      const checks: string[] = [];
      ensureDockerAvailable();
      await trackTelemetryEvent(importMetaUrl, {
        event: "docker_check_passed",
        category: "environment",
        properties: { action },
      });
      checks.push("Docker is installed and running");
      const portFree = await isPortFree(config.gatewayPort);
      checks.push(
        portFree
          ? `Port ${config.gatewayPort} is available`
          : `Port ${config.gatewayPort} is already allocated`,
      );
      checks.push(`Data root: ${config.dataRoot}`);
      checks.push(`Bundle root: ${config.bundleRoot}`);
      checks.push(`Compose file: ${config.composeFile}`);
      const result = {
        action,
        message: "Polaris local deployment doctor completed",
        details: checks,
      };
      await trackTelemetryEvent(importMetaUrl, {
        event: "environment_checked",
        category: "environment",
        properties: {
          action,
          docker_running: true,
          port_available: portFree,
          duration_ms: Date.now() - startedAt,
        },
      });
      return result;
    }

    ensureDockerAvailable();
    await trackTelemetryEvent(importMetaUrl, {
      event: "docker_check_passed",
      category: "environment",
      properties: { action },
    });
    ensureEnvFile(config);

    if (action === "start") {
      const portFree = await isPortFree(config.gatewayPort);
      if (!portFree) {
        const ps = captureCompose(config, ["ps", "--format", "json"]).trim();
        if (!ps) {
          throw new Error(`Local deployment port ${config.gatewayPort} is already in use`);
        }
      }
      runCompose(config, ["up", "-d"]);
      await trackTelemetryEvent(importMetaUrl, {
        event: "runtime_up",
        category: "runtime",
        properties: {
          action,
          duration_ms: Date.now() - startedAt,
          gateway_url: config.gatewayUrl,
        },
      });
      return {
        action,
        message: `Polaris local deployment started at ${config.gatewayUrl}`,
      };
    }

    if (action === "stop") {
      runCompose(config, ["down"]);
      await trackTelemetryEvent(importMetaUrl, {
        event: "shutdown_completed",
        category: "runtime",
        properties: {
          action,
          duration_ms: Date.now() - startedAt,
        },
      });
      return {
        action,
        message: "Polaris local deployment stopped",
      };
    }

    if (action === "restart") {
      runCompose(config, ["down"]);
      runCompose(config, ["up", "-d"]);
      await trackTelemetryEvent(importMetaUrl, {
        event: "control_action_completed",
        category: "runtime",
        properties: {
          action,
          duration_ms: Date.now() - startedAt,
        },
      });
      return {
        action,
        message: `Polaris local deployment restarted at ${config.gatewayUrl}`,
      };
    }

    if (action === "upgrade") {
      await trackTelemetryEvent(importMetaUrl, {
        event: "image_pull_started",
        category: "environment",
        properties: { action },
      });
      runCompose(config, ["pull"]);
      await trackTelemetryEvent(importMetaUrl, {
        event: "image_pull_completed",
        category: "environment",
        properties: { action },
      });
      runCompose(config, ["up", "-d"]);
      await trackTelemetryEvent(importMetaUrl, {
        event: "upgrade_completed",
        category: "distribution",
        properties: {
          action,
          duration_ms: Date.now() - startedAt,
        },
      });
      return {
        action,
        message: `Polaris local deployment upgraded at ${config.gatewayUrl}`,
      };
    }

    if (action === "status") {
      const output = captureCompose(config, ["ps"]);
      await trackTelemetryEvent(importMetaUrl, {
        event: "service_health_checked",
        category: "runtime",
        properties: {
          action,
          duration_ms: Date.now() - startedAt,
        },
      });
      return {
        action,
        message: "Polaris local deployment status",
        details: output.trim().split(/\r?\n/u).filter(Boolean),
      };
    }

    if (action === "logs") {
      const output = captureCompose(config, ["logs", "--tail", "200"]);
      return {
        action,
        message: "Polaris local deployment logs",
        details: output.trim().split(/\r?\n/u).filter(Boolean),
      };
    }

    if (action === "open") {
      openUrl(config.gatewayUrl);
      await trackTelemetryEvent(importMetaUrl, {
        event: "desktop_entry_opened",
        category: "runtime",
        properties: {
          action,
          gateway_url: config.gatewayUrl,
        },
      });
      return {
        action,
        message: `Opened ${config.gatewayUrl}`,
      };
    }

    if (action === "uninstall") {
      runCompose(config, ["down", "--remove-orphans"]);
      if (fs.existsSync(config.envFile)) {
        fs.rmSync(config.envFile, { force: true });
      }
      await trackTelemetryEvent(importMetaUrl, {
        event: "uninstall_completed",
        category: "distribution",
        properties: {
          action,
          duration_ms: Date.now() - startedAt,
        },
      });
      return {
        action,
        message: "Polaris local deployment was removed from the local control state",
        details: [`data root preserved: ${config.dataRoot}`],
      };
    }

    throw new Error(`Unsupported local deployment action '${action}'`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await captureTelemetryError(importMetaUrl, error, {
      event:
        action === "install" ? "installer_failed"
        : action === "upgrade" ? "upgrade_failed"
        : action === "doctor" ? "doctor_failed"
        : action === "uninstall" ? "uninstall_failed"
        : action === "start" ? "runtime_up_failed"
        : "control_action_failed",
      properties: {
        action,
        duration_ms: Date.now() - startedAt,
        error_stage: action,
        error_domain: message.toLowerCase().includes("docker")
          ? "docker"
          : message.toLowerCase().includes("port")
            ? "network"
            : "runtime",
      },
    });
    throw error;
  }
}

export function openExternalUrl(url: string): void {
  openUrl(url);
}
