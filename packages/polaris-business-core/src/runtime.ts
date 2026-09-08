export const POLARIS_BUSINESS_RUNTIME_MODE_ENV = "POLARIS_BUSINESS_RUNTIME_MODE";

const READ_ONLY_COMMANDS = new Set([
  "help",
  "--help",
  "-h",
  "version",
  "validate",
  "validate-input",
  "validate-output",
  "templates",
  "platforms",
  "backend-status",
]);

export class PolarisBusinessRuntimeError extends Error {}

/**
 * Business tools may be used locally for deterministic preparation and
 * inspection. Integrated writes and external effects belong to a Polaris
 * durable action, so direct tool execution fails closed in that mode.
 */
export function assertPolarisBusinessCommand(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (String(environment[POLARIS_BUSINESS_RUNTIME_MODE_ENV] ?? "").trim() !== "polaris") {
    return;
  }
  if (!READ_ONLY_COMMANDS.has(command)) {
    throw new PolarisBusinessRuntimeError(
      "integrated business-tool execution requires a Polaris durable action service",
    );
  }
}
