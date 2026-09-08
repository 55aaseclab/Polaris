import { isIntegratedBusinessRuntime } from "./business-runtime.js";

export function allowsLocalSmtpSettings(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isIntegratedBusinessRuntime(env);
}
