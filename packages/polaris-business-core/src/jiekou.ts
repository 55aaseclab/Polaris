/**
 * JieKou.AI (接口AI) HTTP client.
 *
 * Defaults:
 * - Seedance 1.5 Pro image-to-video: Batch (flex) @ 480p, no audio (~$0.006/s)
 * - ElevenLabs Scribe v2 speech-to-text (~$0.004 / 千字)
 *
 * Auth: Bearer token from JIEKOU_API_KEY (or JIEKOU_TOKEN).
 * Base: JIEKOU_BASE_URL (default https://api.highwayapi.ai)
 */

import fs from "node:fs";
import path from "node:path";
import { loadRootEnv } from "./load-env.js";

export const JIEKOU_DEFAULT_BASE_URL = "https://api.highwayapi.ai";

export const JIEKOU_SEEDANCE_I2V_PATH = "/v3/async/seedance-v1.5-pro-i2v";
export const JIEKOU_SEEDANCE_T2V_PATH = "/v3/async/seedance-v1.5-pro-t2v";
export const JIEKOU_TASK_RESULT_PATH = "/v3/async/task-result";
export const JIEKOU_SCRIBE_V2_PATH = "/v3/elevenlabs-scribe-v2";

export type JiekouTaskStatus =
  | "TASK_STATUS_QUEUED"
  | "TASK_STATUS_PROCESSING"
  | "TASK_STATUS_SUCCEED"
  | "TASK_STATUS_FAILED"
  | string;

export type JiekouConfig = {
  apiKey: string;
  baseUrl: string;
};

export class JiekouError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "JiekouError";
  }
}

export function loadJiekouConfig(options?: {
  requireKey?: boolean;
  rootEnv?: string;
}): JiekouConfig | null {
  loadRootEnv(options?.rootEnv);
  const apiKey = (
    process.env.JIEKOU_API_KEY
    || process.env.JIEKOU_TOKEN
    || process.env.INTERFACE_AI_API_KEY
    || ""
  ).trim();
  const baseUrl = (
    process.env.JIEKOU_BASE_URL
    || process.env.JIEKOU_API_BASE
    || JIEKOU_DEFAULT_BASE_URL
  )
    .trim()
    .replace(/\/+$/, "");
  if (!apiKey) {
    if (options?.requireKey) {
      throw new JiekouError(
        "Missing JIEKOU_API_KEY in environment or repo-root .env "
          + "(https://jiekou.ai/settings/key-management)",
      );
    }
    return null;
  }
  return { apiKey, baseUrl };
}

async function jiekouFetch(
  config: JiekouConfig,
  method: string,
  apiPath: string,
  body?: unknown,
  init?: RequestInit,
): Promise<unknown> {
  const url = apiPath.startsWith("http")
    ? apiPath
    : `${config.baseUrl}${apiPath.startsWith("/") ? "" : "/"}${apiPath}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    ...(init?.headers as Record<string, string> | undefined),
  };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      payload = body;
    } else {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
  }
  const response = await fetch(url, {
    method,
    headers,
    body: payload,
    ...init,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }
  if (!response.ok) {
    throw new JiekouError(
      `JieKou ${method} ${apiPath} failed: HTTP ${response.status} ${text.slice(0, 500)}`,
      response.status,
      parsed,
    );
  }
  return parsed;
}

export type SeedanceGenerateInput = {
  prompt: string;
  /** Local image path or https URL or data: URL. */
  image?: string;
  lastImage?: string;
  durationSec?: number;
  resolution?: "480p" | "720p" | "1080p";
  ratio?: "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "21:9" | "adaptive";
  /** flex = batch/offline (cheaper); default = online. */
  serviceTier?: "default" | "flex";
  generateAudio?: boolean;
  watermark?: boolean;
  cameraFixed?: boolean;
  seed?: number;
  fps?: 24;
};

export type SeedanceSubmitResult = {
  task_id: string;
  raw: unknown;
};

function imageToPayload(image: string): string {
  if (image.startsWith("http://") || image.startsWith("https://") || image.startsWith("data:")) {
    return image;
  }
  const abs = path.resolve(image);
  if (!fs.existsSync(abs)) {
    throw new JiekouError(`Seedance image not found: ${image}`);
  }
  const ext = path.extname(abs).toLowerCase().replace(".", "") || "jpeg";
  const mime =
    ext === "png"
      ? "image/png"
      : ext === "webp"
        ? "image/webp"
        : ext === "gif"
          ? "image/gif"
          : ext === "bmp"
            ? "image/bmp"
            : "image/jpeg";
  const b64 = fs.readFileSync(abs).toString("base64");
  return `data:${mime};base64,${b64}`;
}

/** Submit Seedance 1.5 Pro (i2v when image set, else t2v). Defaults: flex/480p/no audio. */
export async function submitSeedanceVideo(
  config: JiekouConfig,
  input: SeedanceGenerateInput,
): Promise<SeedanceSubmitResult> {
  const duration = Math.min(12, Math.max(4, Math.round(input.durationSec ?? 5)));
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    duration,
    resolution: input.resolution ?? "480p",
    ratio: input.ratio ?? "9:16",
    service_tier: input.serviceTier ?? "flex",
    generate_audio: input.generateAudio ?? false,
    watermark: input.watermark ?? false,
    camera_fixed: input.cameraFixed ?? false,
    fps: input.fps ?? 24,
    seed: input.seed ?? -1,
  };
  const apiPath = input.image ? JIEKOU_SEEDANCE_I2V_PATH : JIEKOU_SEEDANCE_T2V_PATH;
  if (input.image) {
    body.image = imageToPayload(input.image);
  }
  if (input.lastImage) {
    body.last_image = imageToPayload(input.lastImage);
  }
  const raw = await jiekouFetch(config, "POST", apiPath, body);
  const taskId =
    raw && typeof raw === "object" && typeof (raw as { task_id?: unknown }).task_id === "string"
      ? (raw as { task_id: string }).task_id
      : null;
  if (!taskId) {
    throw new JiekouError("Seedance response missing task_id", undefined, raw);
  }
  return { task_id: taskId, raw };
}

export type JiekouTaskResult = {
  status: JiekouTaskStatus;
  reason: string | null;
  videoUrl: string | null;
  progressPercent: number | null;
  raw: unknown;
};

export async function getJiekouTaskResult(
  config: JiekouConfig,
  taskId: string,
): Promise<JiekouTaskResult> {
  const raw = await jiekouFetch(
    config,
    "GET",
    `${JIEKOU_TASK_RESULT_PATH}?task_id=${encodeURIComponent(taskId)}`,
  );
  const task =
    raw && typeof raw === "object" && (raw as { task?: unknown }).task
    && typeof (raw as { task: unknown }).task === "object"
      ? ((raw as { task: Record<string, unknown> }).task)
      : {};
  const status = String(task.status ?? "UNKNOWN");
  const reason = typeof task.reason === "string" ? task.reason : null;
  const progress =
    typeof task.progress_percent === "number" ? task.progress_percent : null;
  let videoUrl: string | null = null;
  const videos = (raw as { videos?: unknown })?.videos;
  if (Array.isArray(videos) && videos[0] && typeof videos[0] === "object") {
    const first = videos[0] as { video_url?: unknown };
    if (typeof first.video_url === "string") videoUrl = first.video_url;
  }
  return { status, reason, videoUrl, progressPercent: progress, raw };
}

export async function waitForJiekouVideo(args: {
  config: JiekouConfig;
  taskId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<JiekouTaskResult> {
  const timeoutMs = args.timeoutMs ?? 10 * 60 * 1000;
  const pollIntervalMs = args.pollIntervalMs ?? 5000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await getJiekouTaskResult(args.config, args.taskId);
    if (result.status === "TASK_STATUS_SUCCEED") {
      if (!result.videoUrl) {
        throw new JiekouError("Seedance succeeded but videos[0].video_url missing", undefined, result.raw);
      }
      return result;
    }
    if (result.status === "TASK_STATUS_FAILED") {
      throw new JiekouError(
        `Seedance task failed: ${result.reason ?? "unknown"}`,
        undefined,
        result.raw,
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new JiekouError(`Seedance task timed out after ${timeoutMs}ms: ${args.taskId}`);
}

export async function downloadUrlToFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new JiekouError(`download failed HTTP ${response.status}: ${url}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
}

/** One-shot: submit Seedance → poll → download mp4. */
export async function generateSeedanceVideoFile(args: {
  config?: JiekouConfig;
  input: SeedanceGenerateInput;
  outputPath: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<{ taskId: string; outputPath: string; videoUrl: string }> {
  const config = args.config ?? loadJiekouConfig({ requireKey: true });
  if (!config) throw new JiekouError("JieKou config missing");
  const submitted = await submitSeedanceVideo(config, args.input);
  const done = await waitForJiekouVideo({
    config,
    taskId: submitted.task_id,
    timeoutMs: args.timeoutMs,
    pollIntervalMs: args.pollIntervalMs,
  });
  await downloadUrlToFile(done.videoUrl!, args.outputPath);
  return {
    taskId: submitted.task_id,
    outputPath: args.outputPath,
    videoUrl: done.videoUrl!,
  };
}

export type ScribeV2Input = {
  /** HTTPS URL of audio/video, or local file path (multipart upload). */
  source: string;
  languageCode?: string | null;
  diarize?: boolean;
  tagAudioEvents?: boolean;
  timestampsGranularity?: "none" | "word" | "character";
  seed?: number | null;
};

export type ScribeV2Result = {
  text: string;
  languageCode: string | null;
  languageProbability: number | null;
  words: Array<{
    text: string;
    start: number | null;
    end: number | null;
    type: string | null;
    speakerId: string | null;
  }>;
  raw: unknown;
};

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** ElevenLabs Scribe v2 via JieKou (~$0.004 / 千字). */
export async function transcribeWithScribeV2(
  config: JiekouConfig,
  input: ScribeV2Input,
): Promise<ScribeV2Result> {
  const source = input.source;
  let raw: unknown;

  if (isHttpUrl(source)) {
    raw = await jiekouFetch(config, "POST", JIEKOU_SCRIBE_V2_PATH, {
      cloud_storage_url: source,
      language_code: input.languageCode ?? null,
      diarize: input.diarize ?? false,
      tag_audio_events: input.tagAudioEvents ?? true,
      timestamps_granularity: input.timestampsGranularity ?? "word",
      seed: input.seed ?? null,
      file_format: "other",
    });
  } else {
    const abs = path.resolve(source);
    if (!fs.existsSync(abs)) {
      throw new JiekouError(`audio/video file not found: ${source}`);
    }
    // Prefer JSON + temporary approach: many JieKou STT routes accept only HTTPS.
    // Try multipart `file` first (ElevenLabs-style); fall back to clear error.
    const form = new FormData();
    const bytes = fs.readFileSync(abs);
    const blob = new Blob([new Uint8Array(bytes)]);
    form.append("file", blob, path.basename(abs));
    if (input.languageCode) form.append("language_code", input.languageCode);
    form.append("diarize", String(input.diarize ?? false));
    form.append("tag_audio_events", String(input.tagAudioEvents ?? true));
    form.append("timestamps_granularity", input.timestampsGranularity ?? "word");
    form.append("file_format", "other");
    try {
      raw = await jiekouFetch(config, "POST", JIEKOU_SCRIBE_V2_PATH, form);
    } catch (error) {
      // Retry with cloud_storage_url-shaped JSON is impossible for bare files.
      // Surface guidance.
      if (error instanceof JiekouError) {
        throw new JiekouError(
          `${error.message}. For local files, if multipart is rejected, pass an HTTPS cloud_storage_url instead.`,
          error.statusCode,
          error.body,
        );
      }
      throw error;
    }
  }

  return normalizeScribeResponse(raw);
}

function normalizeScribeResponse(raw: unknown): ScribeV2Result {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  // Some gateways wrap under data/result
  const root =
    obj.data && typeof obj.data === "object"
      ? (obj.data as Record<string, unknown>)
      : obj.result && typeof obj.result === "object"
        ? (obj.result as Record<string, unknown>)
        : obj;

  let text = typeof root.text === "string" ? root.text : "";
  const wordsIn = Array.isArray(root.words) ? root.words : [];
  if (!text && Array.isArray(root.transcripts) && root.transcripts[0]) {
    const first = root.transcripts[0] as Record<string, unknown>;
    text = typeof first.text === "string" ? first.text : "";
  }
  const words = wordsIn
    .filter((w): w is Record<string, unknown> => !!w && typeof w === "object")
    .map((w) => ({
      text: String(w.text ?? ""),
      start: typeof w.start === "number" ? w.start : null,
      end: typeof w.end === "number" ? w.end : null,
      type: typeof w.type === "string" ? w.type : null,
      speakerId: typeof w.speaker_id === "string" ? w.speaker_id : null,
    }));

  return {
    text: text.trim(),
    languageCode: typeof root.language_code === "string" ? root.language_code : null,
    languageProbability:
      typeof root.language_probability === "number" ? root.language_probability : null,
    words,
    raw,
  };
}
