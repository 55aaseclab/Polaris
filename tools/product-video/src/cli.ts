#!/usr/bin/env node
import path from "node:path";
import {
  assertPolarisBusinessCommand,
  PolarisBusinessRuntimeError,
  writeJsonFile,
} from "@polaris/business-core";
import { sha256Json } from "./hash.js";
import { ensureDir, toolVersion, videoCaseDir } from "./paths.js";
import { buildVideoOutput, writeVideoOutput } from "./publish.js";
import { renderVideo } from "./render.js";
import { resolveVideo } from "./resolve.js";
import { initInputFile, runVideo } from "./run.js";
import { VideoError } from "./types.js";
import {
  parseVideoInput,
  parseVideoSnapshot,
  readJson,
} from "./validate.js";

function printHelp(): void {
  console.log(`polaris-product-video ${toolVersion()}

Usage:
  polaris-product-video version
  polaris-product-video init-input --workspace-root <path> --video-id <id> --product-id <n> --bgm <path> [options]
  polaris-product-video resolve --workspace-root <path> --input <path> [--snapshot <path>]
  polaris-product-video render --workspace-root <path> --snapshot <path> [--out-dir <path>]
  polaris-product-video run --workspace-root <path> --input <path> [options]

Engines:
  ffmpeg_kenburns (local)
  image_to_video_api + provider jiekou|seedance → JieKou Seedance 1.5 Pro
    (flex/batch, 480p, no audio by default; needs JIEKOU_API_KEY in repo .env)

run options:
  --out-dir <path>     Video case directory (default: 产品管理/交付归档/videos/<id>)
  --transition cut|fade

init-input options:
  --platform douyin|xiaohongshu|tiktok|instagram|generic
  --purpose seed|unbox|scene|compare
  --locale zh|en
  --hook <text>
  --cta <text>
  --output <path>
`);
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function requireArg(args: string[], name: string): string {
  const value = argValue(args, name);
  if (!value) throw new VideoError(`missing required ${name}`, 2);
  return value;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  if (command === "version") {
    console.log(toolVersion());
    return 0;
  }

  try {
    assertPolarisBusinessCommand(command);
    if (command === "init-input") {
      const workspaceRoot = path.resolve(requireArg(args, "--workspace-root"));
      const videoId = requireArg(args, "--video-id");
      const productId = Number(requireArg(args, "--product-id"));
      if (!Number.isInteger(productId)) throw new VideoError("product-id must be integer", 2);
      const out = initInputFile({
        workspaceRoot,
        videoId,
        productId,
        bgmPath: requireArg(args, "--bgm"),
        platform: argValue(args, "--platform") as never,
        purpose: argValue(args, "--purpose") as never,
        locale: argValue(args, "--locale") as never,
        hook: argValue(args, "--hook"),
        cta: argValue(args, "--cta"),
        outputPath: argValue(args, "--output"),
      });
      console.log(out);
      return 0;
    }

    if (command === "resolve") {
      const workspaceRoot = path.resolve(requireArg(args, "--workspace-root"));
      const inputPath = path.resolve(requireArg(args, "--input"));
      const input = parseVideoInput(readJson(inputPath));
      const snapshot = resolveVideo(workspaceRoot, input);
      const snapshotPath = path.resolve(
        argValue(args, "--snapshot") ??
          path.join(videoCaseDir(workspaceRoot, input.video_id), "work", "snapshot.json"),
      );
      ensureDir(path.dirname(snapshotPath));
      writeJsonFile(snapshotPath, snapshot);
      parseVideoSnapshot(snapshot);
      console.log(
        JSON.stringify(
          {
            snapshot: snapshotPath,
            shots: snapshot.timeline.length,
            duration_sec: snapshot.timeline.at(-1)?.t_end ?? 0,
            warnings: snapshot.warnings,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    if (command === "render") {
      const workspaceRoot = path.resolve(requireArg(args, "--workspace-root"));
      const snapshotPath = path.resolve(requireArg(args, "--snapshot"));
      const snapshot = parseVideoSnapshot(readJson(snapshotPath));
      const outDir = path.resolve(
        argValue(args, "--out-dir") ?? videoCaseDir(workspaceRoot, snapshot.video_id),
      );
      const workDir = path.join(outDir, "work");
      const outputsDir = path.join(outDir, "outputs");
      const rendered = await renderVideo({
        workspaceRoot,
        snapshot,
        workDir,
        outputsDir,
        transition: "fade",
        api: snapshot.api,
      });
      writeJsonFile(snapshotPath, rendered.updatedSnapshot);
      const manifestPath = path.join(outputsDir, "output.json");
      const output = buildVideoOutput({
        workspaceRoot,
        snapshot: rendered.updatedSnapshot,
        inputSha256: snapshot.from_input_sha256,
        snapshotPath,
        videoPath: rendered.videoPath,
        coverPath: rendered.coverPath,
        srtPath: rendered.srtPath,
        manifestPath,
        audioMixPath: rendered.audioMixPath,
      });
      writeVideoOutput(manifestPath, output);
      console.log(
        JSON.stringify(
          {
            video: rendered.videoPath,
            cover: rendered.coverPath,
            srt: rendered.srtPath,
            output: manifestPath,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    if (command === "run") {
      const workspaceRoot = path.resolve(requireArg(args, "--workspace-root"));
      const inputPath = requireArg(args, "--input");
      const transition = argValue(args, "--transition") as "cut" | "fade" | undefined;
      const result = await runVideo({
        workspaceRoot,
        inputPath,
        outDir: argValue(args, "--out-dir"),
        transition,
      });
      const inputAbs = path.isAbsolute(inputPath)
        ? inputPath
        : path.resolve(workspaceRoot, inputPath);
      console.log(
        JSON.stringify(
          {
            output: result.outputPath,
            video: result.videoPath,
            cover: result.coverPath,
            srt: result.srtPath,
            shots: result.snapshot.timeline.length,
            duration_sec: result.snapshot.timeline.at(-1)?.t_end ?? 0,
            input_sha256: sha256Json(parseVideoInput(readJson(inputAbs))),
          },
          null,
          2,
        ),
      );
      return 0;
    }

    throw new VideoError(`unknown command: ${command}`, 2);
  } catch (error) {
    if (error instanceof VideoError || error instanceof PolarisBusinessRuntimeError) {
      console.error(error.message);
      return error instanceof PolarisBusinessRuntimeError ? 2 : error.exitCode;
    }
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
