import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ensureDir,
  findFfmpeg,
  findFfprobe,
  resolveUnderWorkspace,
  toWorkspaceRelative,
} from "./paths.js";
import { VideoError, type Motion, type VideoSnapshot } from "./types.js";

function isJiekouSeedanceProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  const p = provider.trim().toLowerCase();
  return (
    p === "jiekou"
    || p === "jiekou-ai"
    || p === "seedance"
    || p === "jiekou-seedance"
    || p.includes("seedance")
  );
}

function run(cmd: string, args: string[], label: string): void {
  const result = spawnSync(cmd, args, { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").slice(-2000);
    throw new VideoError(`${label} failed (exit ${result.status}): ${err}`, 4);
  }
}

function resolveDrawtextFont(): string | null {
  const candidates = [
    process.env.POLARIS_BUSINESS_VIDEO_FONT,
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function zoompanFilter(
  motion: Motion,
  durationSec: number,
  fps: number,
  width: number,
  height: number,
): string {
  const frames = Math.max(1, Math.round(durationSec * fps));
  const d = frames;
  // Pre-scale so zoompan has room to crop
  const base = `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,crop=${width * 2}:${height * 2}`;
  switch (motion) {
    case "zoom_in":
      return `${base},zoompan=z='min(1.0+0.0015*on,1.25)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${d}:s=${width}x${height}:fps=${fps}`;
    case "zoom_out":
      return `${base},zoompan=z='if(eq(on,1),1.25,max(1.25-0.0015*on,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${d}:s=${width}x${height}:fps=${fps}`;
    case "pan_left":
      return `${base},zoompan=z='1.15':x='(iw-iw/zoom)*on/${d}':y='ih/2-(ih/zoom/2)':d=${d}:s=${width}x${height}:fps=${fps}`;
    case "pan_right":
      return `${base},zoompan=z='1.15':x='(iw-iw/zoom)*(1-on/${d})':y='ih/2-(ih/zoom/2)':d=${d}:s=${width}x${height}:fps=${fps}`;
    case "static":
    default:
      return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps}`;
  }
}

function writeShotAss(
  assPath: string,
  text: string,
  width: number,
  height: number,
  box: { x: number; y: number; w: number; h: number },
  durationSec: number,
): void {
  const font = resolveDrawtextFont();
  const fontName = font?.includes("Noto") ? "Noto Sans CJK SC" : font?.includes("uming") ? "AR PL UMing" : "DejaVu Sans";
  const fontsize = Math.max(28, Math.round(width / 22));
  // ASS uses centiseconds
  const end = Math.max(1, Math.round(durationSec * 100));
  const endTs = `0:00:${String(Math.floor(end / 100)).padStart(2, "0")}.${String(end % 100).padStart(2, "0")}`;
  const marginV = Math.max(0, height - box.y - box.h);
  const safeText = text.replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, "\\N");
  const content = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontsize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,0,2,40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,${endTs},Default,,0,0,0,,${safeText}
`;
  fs.writeFileSync(assPath, content, "utf-8");
}

function renderKenBurnsShot(
  ffmpeg: string,
  imageAbs: string,
  outAbs: string,
  motion: Motion,
  durationSec: number,
  fps: number,
  width: number,
  height: number,
  caption: {
    enabled: boolean;
    burnIn: boolean;
    text: string;
    box: { x: number; y: number; w: number; h: number };
    assPath?: string;
  },
): void {
  let vf = zoompanFilter(motion, durationSec, fps, width, height);
  // Prefer libass subtitles filter (available on static ffmpeg builds).
  if (caption.enabled && caption.burnIn && caption.text && caption.assPath) {
    writeShotAss(caption.assPath, caption.text, width, height, caption.box, durationSec);
    const assEscaped = caption.assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    vf = `${vf},subtitles='${assEscaped}'`;
  }
  const args = [
    "-y",
    "-loop",
    "1",
    "-i",
    imageAbs,
    "-vf",
    vf,
    "-t",
    String(durationSec),
    "-r",
    String(fps),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-an",
    outAbs,
  ];
  run(ffmpeg, args, `render shot ${path.basename(outAbs)}`);
}

function writeSrt(snapshot: VideoSnapshot, srtPath: string): void {
  const lines: string[] = [];
  const fmt = (sec: number): string => {
    const ms = Math.round(sec * 1000);
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const milli = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(milli).padStart(3, "0")}`;
  };
  snapshot.timeline.forEach((shot, i) => {
    lines.push(String(i + 1));
    lines.push(`${fmt(shot.t_start)} --> ${fmt(shot.t_end)}`);
    lines.push(shot.text);
    lines.push("");
  });
  fs.writeFileSync(srtPath, lines.join("\n"), "utf-8");
}

function concatClips(
  ffmpeg: string,
  clipPaths: string[],
  listPath: string,
  outPath: string,
  transition: "cut" | "fade",
  fps: number,
): void {
  if (transition === "fade" && clipPaths.length > 1) {
    // xfade chain; keep simple 0.25s crossfade
    const fade = 0.25;
    let filter = "";
    let lastLabel = "[0:v]";
    let offset = 0;
    const inputs: string[] = [];
    for (const clip of clipPaths) {
      inputs.push("-i", clip);
    }
    // Probe durations from snapshot would be better; use ffprobe
    const durations = clipPaths.map((p) => probeDuration(p));
    for (let i = 1; i < clipPaths.length; i += 1) {
      offset += Math.max(0.1, durations[i - 1]! - fade);
      const outLabel = i === clipPaths.length - 1 ? "[vout]" : `[v${i}]`;
      filter += `${lastLabel}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}${outLabel};`;
      lastLabel = outLabel;
    }
    filter = filter.replace(/;$/, "");
    const args = [
      "-y",
      ...inputs,
      "-filter_complex",
      filter,
      "-map",
      "[vout]",
      "-r",
      String(fps),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      outPath,
    ];
    run(ffmpeg, args, "xfade concat");
    return;
  }

  const listBody = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  fs.writeFileSync(listPath, listBody, "utf-8");
  run(
    ffmpeg,
    ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", outPath],
    "concat",
  );
}

function probeDuration(filePath: string): number {
  const ffprobe = findFfprobe();
  const result = spawnSync(
    ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) return 3;
  const n = Number(String(result.stdout).trim());
  return Number.isFinite(n) ? n : 3;
}

function muxAudio(
  ffmpeg: string,
  videoPath: string,
  bgmPath: string | null,
  voiceoverPath: string | null,
  loopBgm: boolean,
  bgmVolume: number,
  voVolume: number,
  outPath: string,
  durationSec: number,
): void {
  if (!bgmPath && !voiceoverPath) {
    throw new VideoError("muxAudio: no audio source", 4);
  }
  const args: string[] = ["-y", "-i", videoPath];
  if (bgmPath) {
    if (loopBgm) args.push("-stream_loop", "-1");
    args.push("-i", bgmPath);
  }
  if (voiceoverPath) {
    args.push("-i", voiceoverPath);
  }

  if (bgmPath && voiceoverPath) {
    const bgmIdx = 1;
    const voIdx = 2;
    args.push(
      "-filter_complex",
      `[${bgmIdx}:a]volume=${bgmVolume}[bgm];[${voIdx}:a]volume=${voVolume}[vo];[bgm][vo]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
      "-map",
      "0:v",
      "-map",
      "[aout]",
    );
  } else if (bgmPath) {
    args.push(
      "-filter_complex",
      `[1:a]volume=${bgmVolume}[aout]`,
      "-map",
      "0:v",
      "-map",
      "[aout]",
    );
  } else if (voiceoverPath) {
    args.push(
      "-filter_complex",
      `[1:a]volume=${voVolume}[aout]`,
      "-map",
      "0:v",
      "-map",
      "[aout]",
    );
  }

  args.push(
    "-t",
    String(durationSec),
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-shortest",
    outPath,
  );
  run(ffmpeg, args, "mux audio");
}

function extractCover(
  ffmpeg: string,
  workspaceRoot: string,
  snapshot: VideoSnapshot,
  videoPath: string,
  coverPath: string,
): void {
  const slot = snapshot.cover_plan.preferred_slot;
  if (slot && snapshot.product.images[slot]) {
    const img = snapshot.product.images[slot]!;
    const abs = resolveUnderWorkspace(workspaceRoot, img.path, "cover image");
    run(
      ffmpeg,
      [
        "-y",
        "-i",
        abs,
        "-vf",
        `scale=${snapshot.target.width}:${snapshot.target.height}:force_original_aspect_ratio=increase,crop=${snapshot.target.width}:${snapshot.target.height}`,
        "-frames:v",
        "1",
        coverPath,
      ],
      "cover from image",
    );
    return;
  }
  const t = snapshot.cover_plan.frame_at_sec ?? 0;
  run(
    ffmpeg,
    ["-y", "-ss", String(t), "-i", videoPath, "-frames:v", "1", coverPath],
    "cover from frame",
  );
}

export type RenderResult = {
  videoPath: string;
  coverPath: string;
  srtPath: string;
  audioMixPath: string | null;
  silentVideoPath: string;
  updatedSnapshot: VideoSnapshot;
};

export async function renderVideo(args: {
  workspaceRoot: string;
  snapshot: VideoSnapshot;
  workDir: string;
  outputsDir: string;
  transition: "cut" | "fade";
  /** From input.render.api when engine is image_to_video_api. */
  api?: {
    provider: string;
    model: string | null;
    endpoint_env: string | null;
    per_shot_prompt_template: string | null;
  } | null;
}): Promise<RenderResult> {
  const { workspaceRoot, snapshot, workDir, outputsDir } = args;
  const ffmpeg = findFfmpeg();
  ensureDir(workDir);
  ensureDir(outputsDir);
  const clipsDir = path.join(workDir, "clips");
  ensureDir(clipsDir);

  if (snapshot.mode === "footage") {
    throw new VideoError("mode=footage render not implemented in v1", 4);
  }

  const api = args.api ?? snapshot.api ?? null;
  const useSeedance =
    snapshot.engine === "image_to_video_api"
    && isJiekouSeedanceProvider(api?.provider);

  if (snapshot.engine === "image_to_video_api" && !useSeedance) {
    if (snapshot.fallback === "ffmpeg_kenburns") {
      // fall through with kenburns
    } else {
      throw new VideoError(
        `render.engine=image_to_video_api provider=${api?.provider ?? "null"} is not wired; `
          + "use provider jiekou|seedance or set render.fallback=ffmpeg_kenburns",
        4,
      );
    }
  }

  let silentPath = path.join(workDir, "video-silent.mp4");
  let updatedTimeline = snapshot.timeline;
  let seedanceOk = false;

  if (useSeedance) {
    const { renderWithSeedance, seedanceWorkPath } = await import("./seedance.js");
    const rawPath = seedanceWorkPath(workDir);
    try {
      const generated = await renderWithSeedance({
        workspaceRoot,
        snapshot,
        outputPath: rawPath,
      });
      run(
        ffmpeg,
        [
          "-y",
          "-i",
          rawPath,
          "-an",
          "-vf",
          `scale=${snapshot.target.width}:${snapshot.target.height}:force_original_aspect_ratio=increase,crop=${snapshot.target.width}:${snapshot.target.height},fps=${snapshot.target.fps}`,
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          silentPath,
        ],
        "normalize seedance video",
      );
      seedanceOk = true;
      updatedTimeline = snapshot.timeline.map((shot) => ({
        ...shot,
        render_trace: {
          engine: "image_to_video_api",
          provider: "jiekou-seedance-v1.5-pro",
          request_id: generated.taskId,
          fallback_used: false,
        },
      }));
    } catch (error) {
      if (snapshot.fallback !== "ffmpeg_kenburns") {
        throw error instanceof VideoError
          ? error
          : new VideoError(error instanceof Error ? error.message : String(error), 4);
      }
    }
  }

  const needsKenburns = !seedanceOk;

  if (needsKenburns) {
    const clipPaths: string[] = [];
    updatedTimeline = snapshot.timeline.map((shot) => {
      const imageAbs = resolveUnderWorkspace(workspaceRoot, shot.source.path, `shot[${shot.index}]`);
      const clipPath = path.join(clipsDir, `shot-${String(shot.index).padStart(2, "0")}.mp4`);
      const assPath = path.join(clipsDir, `shot-${String(shot.index).padStart(2, "0")}.ass`);
      const useFallback = snapshot.engine === "image_to_video_api";
      renderKenBurnsShot(
        ffmpeg,
        imageAbs,
        clipPath,
        shot.motion,
        shot.duration_sec,
        snapshot.target.fps,
        snapshot.target.width,
        snapshot.target.height,
        {
          enabled: snapshot.captions.enabled,
          burnIn: snapshot.captions.burn_in,
          text: shot.text,
          box: shot.caption_box,
          assPath,
        },
      );
      clipPaths.push(clipPath);
      return {
        ...shot,
        render_trace: {
          engine: "ffmpeg_kenburns",
          provider: useFallback ? api?.provider ?? null : null,
          request_id: null,
          fallback_used: useFallback,
        },
      };
    });

    silentPath = path.join(workDir, "video-silent.mp4");
    const listPath = path.join(workDir, "concat.txt");
    concatClips(ffmpeg, clipPaths, listPath, silentPath, args.transition, snapshot.target.fps);
  }

  const srtPath = path.join(outputsDir, "captions.srt");
  writeSrt({ ...snapshot, timeline: updatedTimeline }, srtPath);

  const totalDuration =
    updatedTimeline.length > 0
      ? updatedTimeline[updatedTimeline.length - 1]!.t_end
      : snapshot.target.duration_sec;

  if (!snapshot.audio_plan.bgm && !snapshot.audio_plan.voiceover) {
    throw new VideoError("audio plan has no bgm or voiceover after resolve", 4);
  }

  const bgmAbs = snapshot.audio_plan.bgm
    ? resolveUnderWorkspace(workspaceRoot, snapshot.audio_plan.bgm.path, "bgm")
    : null;
  const voAbs = snapshot.audio_plan.voiceover
    ? resolveUnderWorkspace(workspaceRoot, snapshot.audio_plan.voiceover.path, "voiceover")
    : null;

  const videoPath = path.join(outputsDir, "video.mp4");
  muxAudio(
    ffmpeg,
    silentPath,
    bgmAbs,
    voAbs,
    snapshot.audio_plan.loop_bgm,
    snapshot.audio_plan.bgm?.volume ?? 0.7,
    snapshot.audio_plan.voiceover?.volume ?? 1,
    videoPath,
    totalDuration,
  );

  // export audio mix sidecar
  let audioMixPath: string | null = path.join(outputsDir, "audio-mix.m4a");
  run(
    ffmpeg,
    ["-y", "-i", videoPath, "-vn", "-c:a", "aac", audioMixPath],
    "extract audio mix",
  );

  const coverPath = path.join(outputsDir, "cover.jpg");
  extractCover(ffmpeg, workspaceRoot, snapshot, videoPath, coverPath);

  // Verify audio stream exists
  const probe = spawnSync(
    findFfprobe(),
    [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "csv=p=0",
      videoPath,
    ],
    { encoding: "utf-8" },
  );
  if (!String(probe.stdout).includes("audio")) {
    throw new VideoError("rendered video has no audio stream", 4);
  }

  return {
    videoPath,
    coverPath,
    srtPath,
    audioMixPath,
    silentVideoPath: silentPath,
    updatedSnapshot: { ...snapshot, timeline: updatedTimeline },
  };
}

export function assertRenderArtifacts(workspaceRoot: string, result: RenderResult): void {
  for (const p of [result.videoPath, result.coverPath, result.srtPath]) {
    if (!fs.existsSync(p)) {
      throw new VideoError(`missing artifact: ${toWorkspaceRelative(workspaceRoot, p)}`, 4);
    }
  }
}
