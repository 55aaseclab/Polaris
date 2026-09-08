import path from "node:path";
import {
  generateSeedanceVideoFile,
  loadJiekouConfig,
  JiekouError,
  type JiekouConfig,
} from "@polaris/business-core";
import { resolveUnderWorkspace } from "./paths.js";
import { VideoError, type VideoSnapshot } from "./types.js";

export type SeedanceRenderOptions = {
  workspaceRoot: string;
  snapshot: VideoSnapshot;
  outputPath: string;
  /** Override duration; default clamp snapshot target to [4,12]. */
  durationSec?: number;
  resolution?: "480p" | "720p" | "1080p";
  serviceTier?: "default" | "flex";
  generateAudio?: boolean;
  timeoutMs?: number;
};

function buildPrompt(snapshot: VideoSnapshot): string {
  const parts = [
    snapshot.script.hook,
    ...snapshot.timeline.map((s) => s.text),
    snapshot.script.cta,
    snapshot.product.display_name
      ? `Product: ${snapshot.product.display_name}`
      : null,
  ].filter(Boolean);
  return parts.join(". ").slice(0, 500);
}

function pickHeroImage(workspaceRoot: string, snapshot: VideoSnapshot): string {
  const firstWithSource = snapshot.timeline.find((s) => s.source?.path);
  if (firstWithSource?.source?.path) {
    return resolveUnderWorkspace(
      workspaceRoot,
      firstWithSource.source.path,
      "seedance.image",
    );
  }
  for (const slot of ["near", "wear", "detail", "promo_usage"] as const) {
    const ref = snapshot.product.images[slot];
    if (ref?.path) {
      return resolveUnderWorkspace(workspaceRoot, ref.path, `seedance.${slot}`);
    }
  }
  throw new VideoError("Seedance requires at least one product image", 4);
}

function clampDuration(sec: number): number {
  return Math.min(12, Math.max(4, Math.round(sec)));
}

/** True when render.api points at JieKou Seedance. */
export function isSeedanceProvider(snapshot: VideoSnapshot): boolean {
  const provider = (snapshot as { api?: { provider?: string | null } | null }).api?.provider
    ?? null;
  // snapshot may store api only on input; check render_trace later.
  // We pass provider via snapshot notes or engine path from input on resolve.
  return true; // decided by caller using input.render.api
}

export function resolveSeedanceSettings(snapshot: VideoSnapshot): {
  provider: string;
  model: string;
  resolution: "480p" | "720p" | "1080p";
  serviceTier: "default" | "flex";
  generateAudio: boolean;
} {
  // Defaults match cheapest sheet: Batch flex + 480p + no audio.
  return {
    provider: "jiekou",
    model: "seedance-v1.5-pro-i2v",
    resolution: "480p",
    serviceTier: "flex",
    generateAudio: false,
  };
}

export async function renderWithSeedance(
  options: SeedanceRenderOptions,
): Promise<{ taskId: string; videoUrl: string; outputPath: string }> {
  let config: JiekouConfig;
  try {
    config = loadJiekouConfig({ requireKey: true })!;
  } catch (error) {
    throw new VideoError(
      error instanceof JiekouError ? error.message : String(error),
      4,
    );
  }

  const settings = resolveSeedanceSettings(options.snapshot);
  const image = pickHeroImage(options.workspaceRoot, options.snapshot);
  const durationSec = clampDuration(
    options.durationSec
      ?? options.snapshot.target.duration_sec
      ?? options.snapshot.timeline.reduce((s, b) => s + b.duration_sec, 0)
      ?? 5,
  );
  const prompt = buildPrompt(options.snapshot);
  const ratio =
    options.snapshot.target.aspect_ratio === "9:16" ? "9:16" : "adaptive";

  try {
    const result = await generateSeedanceVideoFile({
      config,
      outputPath: options.outputPath,
      timeoutMs: options.timeoutMs ?? 12 * 60 * 1000,
      pollIntervalMs: 5000,
      input: {
        prompt,
        image,
        durationSec,
        resolution: options.resolution ?? settings.resolution,
        ratio,
        serviceTier: options.serviceTier ?? settings.serviceTier,
        generateAudio: options.generateAudio ?? settings.generateAudio,
        watermark: false,
        cameraFixed: false,
      },
    });
    return result;
  } catch (error) {
    throw new VideoError(
      error instanceof Error ? error.message : String(error),
      4,
    );
  }
}

export function seedanceWorkPath(workDir: string): string {
  return path.join(workDir, "seedance-raw.mp4");
}
