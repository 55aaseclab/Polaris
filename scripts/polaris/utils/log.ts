type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function configuredLevel(): LogLevel {
  const raw = String(process.env.POLARIS_LOG_LEVEL ?? "info").trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

function shouldLog(level: LogLevel): boolean {
  return ORDER[level] >= ORDER[configuredLevel()];
}

function stamp(): string {
  return new Date().toISOString();
}

function write(level: LogLevel, scope: string, message: string, details?: Record<string, unknown>): void {
  if (!shouldLog(level)) {
    return;
  }
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`[${stamp()}] [${level}] [${scope}] ${message}${suffix}\n`);
}

export function logDebug(scope: string, message: string, details?: Record<string, unknown>): void {
  write("debug", scope, message, details);
}

export function logInfo(scope: string, message: string, details?: Record<string, unknown>): void {
  write("info", scope, message, details);
}

export function logWarn(scope: string, message: string, details?: Record<string, unknown>): void {
  write("warn", scope, message, details);
}

export function logError(scope: string, message: string, details?: Record<string, unknown>): void {
  write("error", scope, message, details);
}
