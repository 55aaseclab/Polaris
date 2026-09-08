import fs from "node:fs";
import path from "node:path";
import { writeJsonFile } from "@polaris/business-core";
import { sha256File } from "./hash.js";
import { toWorkspaceRelative, utcNow } from "./paths.js";
import { parseVideoOutput } from "./validate.js";
import type { VideoOutput, VideoSnapshot } from "./types.js";

export function buildVideoOutput(args: {
  workspaceRoot: string;
  snapshot: VideoSnapshot;
  inputSha256: string;
  snapshotPath: string;
  videoPath: string;
  coverPath: string;
  srtPath: string;
  manifestPath: string;
  audioMixPath: string | null;
  warnings?: string[];
}): VideoOutput {
  const { workspaceRoot, snapshot } = args;
  const duration =
    snapshot.timeline.length > 0
      ? snapshot.timeline[snapshot.timeline.length - 1]!.t_end
      : snapshot.target.duration_sec;

  const output: VideoOutput = {
    schema: "wanghai.promo.video-output",
    schema_version: 1,
    video_id: snapshot.video_id,
    status: "generated",
    generated_at: utcNow(),
    input_sha256: args.inputSha256,
    snapshot_sha256: sha256File(args.snapshotPath),
    platform: snapshot.platform,
    purpose: snapshot.purpose,
    locale: snapshot.locale,
    mode: snapshot.mode,
    engine: snapshot.engine,
    duration_sec: duration,
    aspect_ratio: snapshot.target.aspect_ratio,
    product: {
      product_id: snapshot.product.product_id,
      slug: snapshot.product.slug,
      batch: snapshot.product.batch,
      name: snapshot.product.display_name,
      source_meta_sha256: snapshot.product.source_meta_sha256,
    },
    compare: snapshot.compare
      ? {
          mode: snapshot.compare.mode,
          baseline_label: snapshot.compare.baseline_label,
          other_product_id: snapshot.compare.other_product_id,
          other_label: snapshot.compare.other_label,
        }
      : null,
    timeline_summary: snapshot.timeline.map((shot) => ({
      index: shot.index,
      role: shot.role,
      t_start: shot.t_start,
      t_end: shot.t_end,
      text: shot.text,
      source_path: shot.source.path,
    })),
    artifacts: {
      video: toWorkspaceRelative(workspaceRoot, args.videoPath),
      cover: toWorkspaceRelative(workspaceRoot, args.coverPath),
      captions_srt: toWorkspaceRelative(workspaceRoot, args.srtPath),
      snapshot: toWorkspaceRelative(workspaceRoot, args.snapshotPath),
      manifest: toWorkspaceRelative(workspaceRoot, args.manifestPath),
      audio_mix: args.audioMixPath
        ? toWorkspaceRelative(workspaceRoot, args.audioMixPath)
        : null,
    },
    publish_hints: {
      title_candidate: snapshot.script.hook,
      caption_lines: snapshot.timeline.map((s) => s.text),
      hashtags: [],
    },
    warnings: args.warnings ?? snapshot.warnings,
  };

  parseVideoOutput(output);
  return output;
}

export function writeVideoOutput(manifestPath: string, output: VideoOutput): void {
  writeJsonFile(manifestPath, output);
}

export function writeRunManifest(runDir: string, payload: Record<string, unknown>): void {
  fs.mkdirSync(runDir, { recursive: true });
  writeJsonFile(path.join(runDir, "run.json"), payload);
}
