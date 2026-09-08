import path from "node:path";
import { writeJsonFile } from "@polaris/business-core";
import { sha256Json } from "./hash.js";
import {
  ensureDir,
  toolVersion,
  toWorkspaceRelative,
  tryWorkspaceRelative,
  utcNow,
  videoCaseDir,
} from "./paths.js";
import { buildVideoOutput, writeRunManifest, writeVideoOutput } from "./publish.js";
import { assertRenderArtifacts, renderVideo } from "./render.js";
import { resolveVideo } from "./resolve.js";
import { VideoError, type VideoInput, type VideoSnapshot } from "./types.js";
import {
  defaultVideoInput,
  parseVideoInput,
  parseVideoSnapshot,
  readJson,
} from "./validate.js";

export type RunOptions = {
  workspaceRoot: string;
  input?: VideoInput;
  inputPath?: string;
  outDir?: string;
  transition?: "cut" | "fade";
};

export type RunResult = {
  snapshot: VideoSnapshot;
  outputPath: string;
  videoPath: string;
  coverPath: string;
  srtPath: string;
  snapshotPath: string;
};

function resolveOutDir(workspaceRoot: string, input: VideoInput, outDir?: string): string {
  if (outDir) {
    return path.isAbsolute(outDir) ? outDir : path.resolve(workspaceRoot, outDir);
  }
  return videoCaseDir(workspaceRoot, input.video_id);
}

export function loadInput(options: RunOptions): { input: VideoInput; inputPath: string | null } {
  if (options.input) {
    return { input: parseVideoInput(options.input), inputPath: options.inputPath ?? null };
  }
  if (!options.inputPath) {
    throw new VideoError("either input or inputPath is required", 2);
  }
  const absolute = path.isAbsolute(options.inputPath)
    ? options.inputPath
    : path.resolve(options.workspaceRoot, options.inputPath);
  return { input: parseVideoInput(readJson(absolute)), inputPath: absolute };
}

export async function runVideo(options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const { input, inputPath } = loadInput(options);
  const outDir = resolveOutDir(options.workspaceRoot, input, options.outDir);
  const inputsDir = path.join(outDir, "inputs");
  const workDir = path.join(outDir, "work");
  const outputsDir = path.join(outDir, "outputs");
  const runsDir = path.join(outDir, "runs", utcNow().replace(/[:.]/g, "-"));
  ensureDir(inputsDir);
  ensureDir(workDir);
  ensureDir(outputsDir);
  ensureDir(runsDir);

  const savedInputPath = path.join(inputsDir, "input.json");
  writeJsonFile(savedInputPath, input);

  const snapshot = resolveVideo(options.workspaceRoot, input);
  const snapshotPath = path.join(workDir, "snapshot.json");
  writeJsonFile(snapshotPath, snapshot);
  parseVideoSnapshot(snapshot);

  const transition = options.transition ?? input.render.transition;
  // renderVideo is async (Seedance / JieKou path)
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  const rendered = await renderVideo({
    workspaceRoot: options.workspaceRoot,
    snapshot,
    workDir,
    outputsDir,
    transition,
    api: input.render.api,
  });
  assertRenderArtifacts(options.workspaceRoot, rendered);

  // persist updated snapshot with render_trace
  writeJsonFile(snapshotPath, rendered.updatedSnapshot);
  parseVideoSnapshot(rendered.updatedSnapshot);

  const warnings = [...rendered.updatedSnapshot.warnings];
  if (rendered.updatedSnapshot.timeline.some((s) => s.render_trace.fallback_used)) {
    warnings.push("engine_fallback_used");
  }

  const manifestPath = path.join(outputsDir, "output.json");
  const output = buildVideoOutput({
    workspaceRoot: options.workspaceRoot,
    snapshot: rendered.updatedSnapshot,
    inputSha256: sha256Json(input),
    snapshotPath,
    videoPath: rendered.videoPath,
    coverPath: rendered.coverPath,
    srtPath: rendered.srtPath,
    manifestPath,
    audioMixPath: rendered.audioMixPath,
    warnings,
  });
  writeVideoOutput(manifestPath, output);

  writeRunManifest(runsDir, {
    schema: "wanghai.promo.video-run",
    schema_version: 1,
    status: "ok",
    tool_version: toolVersion(),
    started_at: new Date(started).toISOString(),
    finished_at: utcNow(),
    duration_ms: Date.now() - started,
    input_path: inputPath ? tryWorkspaceRelative(options.workspaceRoot, inputPath) : null,
    saved_input: toWorkspaceRelative(options.workspaceRoot, savedInputPath),
    snapshot: output.artifacts.snapshot,
    video: output.artifacts.video,
    cover: output.artifacts.cover,
    captions_srt: output.artifacts.captions_srt,
    manifest: output.artifacts.manifest,
    warnings,
  });

  return {
    snapshot: rendered.updatedSnapshot,
    outputPath: manifestPath,
    videoPath: rendered.videoPath,
    coverPath: rendered.coverPath,
    srtPath: rendered.srtPath,
    snapshotPath,
  };
}

export function initInputFile(args: {
  workspaceRoot: string;
  videoId: string;
  productId: number;
  bgmPath: string;
  platform?: VideoInput["platform"];
  purpose?: VideoInput["purpose"];
  locale?: VideoInput["locale"];
  hook?: string;
  cta?: string;
  outputPath?: string;
}): string {
  const input = defaultVideoInput({
    video_id: args.videoId,
    product_id: args.productId,
    bgm_path: args.bgmPath,
    platform: args.platform,
    purpose: args.purpose,
    locale: args.locale,
    hook: args.hook,
    cta: args.cta,
  });
  parseVideoInput(input);
  const out =
    args.outputPath ??
    path.join(videoCaseDir(args.workspaceRoot, args.videoId), "inputs", "input.json");
  const absolute = path.isAbsolute(out) ? out : path.resolve(args.workspaceRoot, out);
  ensureDir(path.dirname(absolute));
  writeJsonFile(absolute, input);
  return absolute;
}
