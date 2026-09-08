export type Locale = "zh" | "en";
export type Platform = "douyin" | "xiaohongshu" | "tiktok" | "instagram" | "generic";
export type Purpose = "seed" | "unbox" | "scene" | "compare";
export type Mode = "stills_motion" | "footage";
export type Engine = "ffmpeg_kenburns" | "image_to_video_api";
export type Motion = "zoom_in" | "zoom_out" | "pan_left" | "pan_right" | "static";
export type ImageSlot = "near" | "wear" | "detail" | "promo_usage";
export type BeatRole =
  | "hook"
  | "show"
  | "proof"
  | "cta"
  | "compare_a"
  | "compare_b"
  | "compare_vs";

export type VideoBeat = {
  role: BeatRole;
  text: string;
  duration_sec: number;
  motion: Motion;
  image_slot: ImageSlot | null;
  image_path: string | null;
  asset_ref: string | null;
  trim: { start_sec: number; end_sec: number } | null;
};

export type VideoInput = {
  schema: "wanghai.promo.video-input";
  schema_version: 1;
  video_id: string;
  product_id: number;
  platform: Platform;
  purpose: Purpose;
  locale: Locale;
  mode: Mode;
  target: {
    aspect_ratio: "9:16";
    duration_sec: number;
    width: number;
    height: number;
    fps: number;
    allow_duration_tolerance_sec: number;
  };
  script: {
    hook: string;
    cta: string;
    beats: VideoBeat[];
  };
  compare: {
    mode: "vs_feature" | "vs_product";
    baseline_label: string;
    baseline_image_path: string | null;
    other_product_id: number | null;
    other_label: string | null;
  } | null;
  captions: {
    enabled: boolean;
    burn_in: boolean;
    style: "safe_zone_bottom" | "center_hook";
  };
  cover: {
    source: "auto" | "near" | "wear" | "detail" | "frame_at_sec";
    frame_at_sec: number | null;
  };
  audio: {
    bgm: {
      path: string;
      volume: number;
      license_note: string | null;
    } | null;
    tts: {
      engine: "api_tts";
      text_source: "beats" | "hook_cta" | "explicit";
      explicit_text: string | null;
      voice: string | null;
      provider: string | null;
      endpoint_env: string | null;
    } | null;
    voiceover: {
      path: string;
      volume: number;
    } | null;
    mix: {
      require_bgm: boolean;
      loop_bgm: boolean;
      music_duck_db: number | null;
    };
  };
  render: {
    engine: Engine;
    transition: "cut" | "fade";
    fallback: "ffmpeg_kenburns" | null;
    api: {
      provider: string;
      model: string | null;
      endpoint_env: string | null;
      per_shot_prompt_template: string | null;
    } | null;
  };
  options: {
    require_ready: boolean;
    require_include_in_external: boolean;
    require_images: ImageSlot[];
  };
  notes: string[];
};

export type ImageRef = {
  path: string;
  sha256: string;
} | null;

export type ProductFreeze = {
  product_id: number;
  slug: string;
  batch: string;
  display_name: string;
  name_en: string | null;
  category: string | null;
  status: string;
  source_meta_sha256: string;
  copy: {
    title: string | null;
    selling_points: string[];
    description: string | null;
  };
  images: Record<ImageSlot, ImageRef>;
};

export type TimelineShot = {
  index: number;
  role: string;
  t_start: number;
  t_end: number;
  duration_sec: number;
  text: string;
  motion: Motion;
  source: {
    kind: "image" | "clip";
    path: string;
    sha256: string;
    slot: ImageSlot | null;
  };
  caption_box: { x: number; y: number; w: number; h: number };
  render_trace: {
    engine: string | null;
    provider: string | null;
    request_id: string | null;
    fallback_used: boolean;
  };
};

export type VideoSnapshot = {
  schema: "wanghai.promo.video-snapshot";
  schema_version: 1;
  video_id: string;
  frozen_at: string;
  from_input_sha256: string;
  platform: Platform;
  purpose: Purpose;
  locale: Locale;
  mode: Mode;
  engine: Engine;
  fallback: "ffmpeg_kenburns" | null;
  api: VideoInput["render"]["api"];
  target: VideoInput["target"];
  product: ProductFreeze;
  compare: {
    mode: "vs_feature" | "vs_product";
    baseline_label: string;
    baseline_image: ImageRef;
    other_product_id: number | null;
    other_label: string | null;
    other: {
      product_id: number;
      slug: string;
      batch: string;
      display_name: string;
      source_meta_sha256: string;
      images: Record<ImageSlot, ImageRef>;
    } | null;
  } | null;
  script: { hook: string; cta: string };
  captions: VideoInput["captions"];
  cover_plan: {
    source: string;
    frame_at_sec: number | null;
    preferred_slot: ImageSlot | null;
  };
  audio_plan: {
    require_bgm: boolean;
    loop_bgm: boolean;
    bgm: {
      path: string;
      sha256: string;
      volume: number;
      license_note: string | null;
    } | null;
    tts: VideoInput["audio"]["tts"];
    voiceover: {
      path: string;
      sha256: string;
      volume: number;
    } | null;
    music_duck_db: number | null;
  };
  timeline: TimelineShot[];
  warnings: string[];
};

export type VideoOutput = {
  schema: "wanghai.promo.video-output";
  schema_version: 1;
  video_id: string;
  status: "generated";
  generated_at: string;
  input_sha256: string;
  snapshot_sha256: string;
  platform: string;
  purpose: string;
  locale: string;
  mode: string;
  engine: string;
  duration_sec: number;
  aspect_ratio: string;
  product: {
    product_id: number;
    slug: string;
    batch: string;
    name: string;
    source_meta_sha256: string;
  };
  compare: {
    mode: string;
    baseline_label: string;
    other_product_id: number | null;
    other_label: string | null;
  } | null;
  timeline_summary: Array<{
    index: number;
    role: string;
    t_start: number;
    t_end: number;
    text: string;
    source_path: string;
  }>;
  artifacts: {
    video: string;
    cover: string;
    captions_srt: string;
    snapshot: string;
    manifest: string;
    audio_mix: string | null;
  };
  publish_hints: {
    title_candidate: string;
    caption_lines: string[];
    hashtags: string[];
  };
  warnings: string[];
};

export class VideoError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "VideoError";
  }
}
