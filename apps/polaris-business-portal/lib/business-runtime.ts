/** Runtime policy for the Polaris-owned business surface. */
export const POLARIS_BUSINESS_RUNTIME_MODE_ENV = "POLARIS_BUSINESS_RUNTIME_MODE";

/**
 * The Wanghai mode is accepted only as an embedded-surface compatibility
 * signal. New Polaris launches must use POLARIS_BUSINESS_RUNTIME_MODE.
 */
export function isIntegratedBusinessRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment[POLARIS_BUSINESS_RUNTIME_MODE_ENV]?.trim() === "polaris"
    || environment.WANGHAI_RUNTIME_MODE?.trim() === "polaris";
}
