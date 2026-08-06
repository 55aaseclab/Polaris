import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Session } from "node:inspector";

export interface CpuProfileArtifact {
  durationMs: number;
  filePath: string;
  nodeCount: number;
  sampleCount: number;
  sha256: string;
}

type InspectorSession = {
  post(
    method: string,
    callback: (error: Error | null, result?: Record<string, unknown>) => void,
  ): void;
};

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function asFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function asProfile(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CPU profiler returned an invalid profile");
  }
  return value as Record<string, unknown>;
}

function post(session: InspectorSession, method: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    session.post(method, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result ?? {});
    });
  });
}

/**
 * Captures only the supplied measured work. The caller owns the fixture and
 * writes the resulting profile outside any disposable benchmark data root.
 */
export async function captureCpuProfile<T>(input: {
  filePath?: string;
  run: () => Promise<T>;
}): Promise<{ value: T; profile?: CpuProfileArtifact }> {
  if (!input.filePath) {
    return { value: await input.run() };
  }

  const session = new Session();
  const inspectorSession = session as unknown as InspectorSession;
  session.connect();
  try {
    await post(inspectorSession, "Profiler.enable");
    await post(inspectorSession, "Profiler.start");
    let value!: T;
    let runFailure: unknown;
    try {
      value = await input.run();
    } catch (error) {
      runFailure = error;
    }
    const result = await post(inspectorSession, "Profiler.stop");
    const profile = asProfile(result.profile);
    const outputPath = path.resolve(input.filePath);
    const payload = `${JSON.stringify(profile)}\n`;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, payload, "utf8");

    if (runFailure) {
      throw runFailure;
    }
    const startedAt = asFiniteNumber(profile.startTime);
    const endedAt = asFiniteNumber(profile.endTime);
    return {
      value,
      profile: {
        durationMs: startedAt === null || endedAt === null ? 0 : rounded((endedAt - startedAt) / 1_000),
        filePath: outputPath,
        nodeCount: Array.isArray(profile.nodes) ? profile.nodes.length : 0,
        sampleCount: Array.isArray(profile.samples) ? profile.samples.length : 0,
        sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
      },
    };
  } finally {
    session.disconnect();
  }
}
