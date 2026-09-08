import fs from "node:fs";
import path from "node:path";
import {
  SCHEMAS_DIR,
  isJsonObject,
  type JsonObject,
  type Schema,
  validateJsonObject,
  SchemaValidationError,
} from "@polaris/business-core";
import { TOOL_SCHEMAS_DIR } from "./paths.js";
import {
  VideoError,
  type BeatRole,
  type Locale,
  type Purpose,
  type VideoInput,
  type VideoOutput,
  type VideoSnapshot,
} from "./types.js";

const VIDEO_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

const PURPOSE_ROLES: Record<Purpose, BeatRole[]> = {
  seed: ["hook", "show", "proof", "cta"],
  unbox: ["hook", "show", "proof", "cta"],
  scene: ["hook", "show", "proof", "cta"],
  compare: ["hook", "compare_a", "compare_b", "compare_vs", "cta"],
};

function loadSchema(name: string): Schema {
  const candidates = [
    path.join(TOOL_SCHEMAS_DIR, name),
    path.join(SCHEMAS_DIR, name),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, "utf-8")) as Schema;
    }
  }
  throw new VideoError(`schema not found: ${name}`, 1);
}

function validateAgainst(name: string, data: JsonObject, label: string): JsonObject {
  try {
    return validateJsonObject(data, loadSchema(name), label);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new VideoError(`${label}: ${error.message}`, 2);
    }
    throw error;
  }
}

function assertPurposeContract(input: VideoInput): void {
  const expected = PURPOSE_ROLES[input.purpose];
  const roles = input.script.beats.map((b) => b.role);
  if (roles.length < expected.length) {
    throw new VideoError(
      `purpose=${input.purpose} requires at least ${expected.length} beats (${expected.join(" → ")}), got ${roles.length}`,
      2,
    );
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (roles[i] !== expected[i]) {
      throw new VideoError(
        `purpose=${input.purpose} beat[${i}] must be role=${expected[i]}, got ${roles[i]}`,
        2,
      );
    }
  }
  // Extra beats after the required prefix are allowed only if they are not
  // reordering the contract; trailing extras must still be known roles.
  for (let i = expected.length; i < roles.length; i += 1) {
    if (!expected.includes(roles[i] as BeatRole) && roles[i] !== "show" && roles[i] !== "proof") {
      // For non-compare, allow extra show/proof only; for compare, no extras.
      if (input.purpose === "compare") {
        throw new VideoError(
          `purpose=compare does not allow extra beat role=${roles[i]} at index ${i}`,
          2,
        );
      }
    }
  }

  if (input.purpose === "compare") {
    if (!input.compare) {
      throw new VideoError("purpose=compare requires compare block", 2);
    }
    if (input.compare.mode === "vs_product" && input.compare.other_product_id == null) {
      throw new VideoError("compare.mode=vs_product requires other_product_id", 2);
    }
    if (
      input.compare.mode === "vs_feature" &&
      !input.compare.baseline_image_path &&
      !input.script.beats.some((b) => b.role === "compare_b" && (b.image_path || b.image_slot))
    ) {
      throw new VideoError(
        "compare.mode=vs_feature requires baseline_image_path or compare_b image binding",
        2,
      );
    }
  } else if (input.compare) {
    throw new VideoError("compare block is only allowed when purpose=compare", 2);
  }
}

function assertScriptAssets(input: VideoInput): void {
  for (const [i, beat] of input.script.beats.entries()) {
    if (input.mode === "stills_motion") {
      if (!beat.image_slot && !beat.image_path) {
        throw new VideoError(
          `beat[${i}] (${beat.role}): stills_motion requires image_slot or image_path`,
          2,
        );
      }
      if (beat.asset_ref) {
        throw new VideoError(
          `beat[${i}] (${beat.role}): asset_ref is only for mode=footage`,
          2,
        );
      }
    } else {
      if (!beat.asset_ref) {
        throw new VideoError(
          `beat[${i}] (${beat.role}): footage mode requires asset_ref`,
          2,
        );
      }
    }
    if (beat.trim && beat.trim.end_sec <= beat.trim.start_sec) {
      throw new VideoError(`beat[${i}]: trim.end_sec must be > start_sec`, 2);
    }
  }

  const sum = input.script.beats.reduce((acc, b) => acc + b.duration_sec, 0);
  const tol = input.target.allow_duration_tolerance_sec;
  if (Math.abs(sum - input.target.duration_sec) > tol) {
    throw new VideoError(
      `sum(beats.duration_sec)=${sum} must match target.duration_sec=${input.target.duration_sec} ± ${tol}`,
      2,
    );
  }
}

function assertAudioContract(input: VideoInput): void {
  const { bgm, tts, voiceover, mix } = input.audio;
  if (mix.require_bgm) {
    if (!bgm?.path) {
      throw new VideoError("audio.mix.require_bgm=true requires audio.bgm.path", 2);
    }
  } else if (!bgm?.path && !tts && !voiceover?.path) {
    throw new VideoError(
      "audio requires at least one of bgm.path, tts, or voiceover.path",
      2,
    );
  }
  if (tts?.text_source === "explicit" && !tts.explicit_text?.trim()) {
    throw new VideoError("audio.tts.text_source=explicit requires explicit_text", 2);
  }
  if (tts && tts.engine === "api_tts" && !tts.provider) {
    throw new VideoError("audio.tts.engine=api_tts requires provider", 2);
  }
}

function assertRenderContract(input: VideoInput): void {
  if (input.render.engine === "image_to_video_api") {
    if (!input.render.api?.provider) {
      throw new VideoError("render.engine=image_to_video_api requires render.api.provider", 2);
    }
  }
}

export function parseVideoInput(data: unknown): VideoInput {
  if (!isJsonObject(data as JsonObject)) {
    throw new VideoError("video input root must be an object", 2);
  }
  const validated = validateAgainst(
    "wanghai.promo.video-input.v1.schema.json",
    data as JsonObject,
    "video-input",
  );
  const input = validated as unknown as VideoInput;
  if (!VIDEO_ID_PATTERN.test(input.video_id)) {
    throw new VideoError(`video_id must match ${VIDEO_ID_PATTERN}`, 2);
  }
  assertPurposeContract(input);
  assertScriptAssets(input);
  assertAudioContract(input);
  assertRenderContract(input);
  return input;
}

export function parseVideoSnapshot(data: unknown): VideoSnapshot {
  if (!isJsonObject(data as JsonObject)) {
    throw new VideoError("video snapshot root must be an object", 2);
  }
  validateAgainst(
    "wanghai.promo.video-snapshot.v1.schema.json",
    data as JsonObject,
    "video-snapshot",
  );
  return data as VideoSnapshot;
}

export function parseVideoOutput(data: unknown): VideoOutput {
  if (!isJsonObject(data as JsonObject)) {
    throw new VideoError("video output root must be an object", 2);
  }
  validateAgainst(
    "wanghai.promo.video-output.v1.schema.json",
    data as JsonObject,
    "video-output",
  );
  return data as VideoOutput;
}

export function readJson(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    throw new VideoError(`file not found: ${filePath}`, 2);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
}

export function defaultVideoInput(args: {
  video_id: string;
  product_id: number;
  platform?: VideoInput["platform"];
  purpose?: Purpose;
  locale?: Locale;
  bgm_path: string;
  hook?: string;
  cta?: string;
}): VideoInput {
  const hook = args.hook ?? "3 秒看懂这枚好物";
  const cta = args.cta ?? "评论区扣 1 拿同款链接";
  return {
    schema: "wanghai.promo.video-input",
    schema_version: 1,
    video_id: args.video_id,
    product_id: args.product_id,
    platform: args.platform ?? "douyin",
    purpose: args.purpose ?? "seed",
    locale: args.locale ?? "zh",
    mode: "stills_motion",
    target: {
      aspect_ratio: "9:16",
      duration_sec: 16,
      width: 1080,
      height: 1920,
      fps: 30,
      allow_duration_tolerance_sec: 0.5,
    },
    script: {
      hook,
      cta,
      beats: [
        {
          role: "hook",
          text: hook,
          duration_sec: 3,
          motion: "zoom_in",
          image_slot: "near",
          image_path: null,
          asset_ref: null,
          trim: null,
        },
        {
          role: "show",
          text: "上身质感，一眼记住",
          duration_sec: 5,
          motion: "pan_right",
          image_slot: "wear",
          image_path: null,
          asset_ref: null,
          trim: null,
        },
        {
          role: "proof",
          text: "细节做工，经得起特写",
          duration_sec: 5,
          motion: "zoom_in",
          image_slot: "detail",
          image_path: null,
          asset_ref: null,
          trim: null,
        },
        {
          role: "cta",
          text: cta,
          duration_sec: 3,
          motion: "static",
          image_slot: "near",
          image_path: null,
          asset_ref: null,
          trim: null,
        },
      ],
    },
    compare: null,
    captions: {
      enabled: true,
      burn_in: true,
      style: "safe_zone_bottom",
    },
    cover: {
      source: "auto",
      frame_at_sec: null,
    },
    audio: {
      bgm: {
        path: args.bgm_path,
        volume: 0.7,
        license_note: "fixture/test only",
      },
      tts: null,
      voiceover: null,
      mix: {
        require_bgm: true,
        loop_bgm: true,
        music_duck_db: null,
      },
    },
    render: {
      engine: "ffmpeg_kenburns",
      transition: "fade",
      fallback: null,
      api: null,
    },
    options: {
      require_ready: true,
      require_include_in_external: false,
      require_images: ["near", "wear", "detail"],
    },
    notes: [],
  };
}
