export function durableJobWorkerConcurrency(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number.parseInt(String(env.POLARIS_JOB_WORKER_CONCURRENCY ?? ""), 10);
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(4, raw));
}
