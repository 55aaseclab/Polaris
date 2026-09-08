import fs from "node:fs";
import path from "node:path";
import {
  findProductById,
  isJsonObject,
  productOrigin,
  productImageSlots,
  skuSubcategoryFromSku,
  skuSubcategoryLabel,
  type JsonObject,
  type ProductSummary,
} from "@polaris/business-core";
import { sha256File, sha256Json } from "./hash.js";
import {
  assertSafeWorkspaceRelative,
  resolveUnderWorkspace,
  utcNow,
} from "./paths.js";
import { captionBox } from "./platform.js";
import {
  VideoError,
  type ImageRef,
  type ImageSlot,
  type ProductFreeze,
  type TimelineShot,
  type VideoInput,
  type VideoSnapshot,
} from "./types.js";

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function asObject(value: unknown): JsonObject {
  return isJsonObject(value as JsonObject) ? (value as JsonObject) : {};
}

function resolveFileRef(
  workspaceRoot: string,
  relativePath: string | null,
  label: string,
): ImageRef {
  if (!relativePath) return null;
  const safe = assertSafeWorkspaceRelative(relativePath, label);
  const absolute = resolveUnderWorkspace(workspaceRoot, safe, label);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new VideoError(`${label}: file missing: ${safe}`, 1);
  }
  return { path: safe, sha256: sha256File(absolute) };
}

function productRelativeImage(
  workspaceRoot: string,
  product: ProductSummary,
  relativeFromMeta: string | null,
  label: string,
): ImageRef {
  if (!relativeFromMeta) return null;
  // selected paths in meta may be relative to product dir or figures_dir-style
  const candidates = [
    path.join(product.path, relativeFromMeta),
    path.resolve(workspaceRoot, relativeFromMeta),
  ];
  for (const absolute of candidates) {
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      const root = path.resolve(workspaceRoot) + path.sep;
      if (!absolute.startsWith(root) && absolute !== path.resolve(workspaceRoot)) {
        continue;
      }
      const rel = path.relative(workspaceRoot, absolute).split(path.sep).join("/");
      return { path: rel, sha256: sha256File(absolute) };
    }
  }
  // Try figures_dir join
  const assets = asObject(product.meta.assets);
  const figuresDir = stringOrNull(assets.figures_dir);
  if (figuresDir) {
    const abs = path.resolve(workspaceRoot, figuresDir, relativeFromMeta);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const rel = path.relative(workspaceRoot, abs).split(path.sep).join("/");
      return { path: rel, sha256: sha256File(abs) };
    }
  }
  throw new VideoError(`${label}: image not found: ${relativeFromMeta}`, 1);
}

function freezeProduct(
  workspaceRoot: string,
  product: ProductSummary,
  requireImages: ImageSlot[],
): ProductFreeze {
  const slots = productImageSlots(product);
  const images: Record<ImageSlot, ImageRef> = {
    near: productRelativeImage(workspaceRoot, product, slots.near, "images.near"),
    wear: productRelativeImage(workspaceRoot, product, slots.wear, "images.wear"),
    detail: productRelativeImage(workspaceRoot, product, slots.detail, "images.detail"),
    promo_usage: productRelativeImage(
      workspaceRoot,
      product,
      slots.promo_usage_image,
      "images.promo_usage",
    ),
  };
  for (const slot of requireImages) {
    if (!images[slot]) {
      throw new VideoError(`required image slot missing: ${slot}`, 3);
    }
  }
  const copy = asObject(product.meta.copy);
  const sellingPoints = Array.isArray(copy.selling_points)
    ? copy.selling_points.map((s) => String(s))
    : [];
  const id = product.meta.id;
  if (typeof id !== "number") {
    throw new VideoError(`product ${product.sku} has no numeric id`, 1);
  }
  return {
    product_id: id,
    slug: product.sku,
    batch: productOrigin(product)?.batch ?? "product-library",
    display_name:
      stringOrNull(product.meta.name) ??
      stringOrNull(product.meta.name_en) ??
      product.sku,
    name_en: stringOrNull(product.meta.name_en),
    category: skuSubcategoryLabel(skuSubcategoryFromSku(product.sku)),
    status: String(product.meta.status ?? "draft"),
    source_meta_sha256: sha256File(product.metaPath),
    copy: {
      title: stringOrNull(copy.title),
      selling_points: sellingPoints,
      description: stringOrNull(copy.description),
    },
    images,
  };
}

function resolveBeatSource(
  workspaceRoot: string,
  input: VideoInput,
  product: ProductFreeze,
  compare: VideoSnapshot["compare"],
  beat: VideoInput["script"]["beats"][number],
  index: number,
): TimelineShot["source"] {
  if (input.mode === "footage") {
    const ref = resolveFileRef(workspaceRoot, beat.asset_ref, `beat[${index}].asset_ref`);
    if (!ref) throw new VideoError(`beat[${index}]: asset_ref missing`, 2);
    return { kind: "clip", path: ref.path, sha256: ref.sha256, slot: null };
  }

  if (beat.image_path) {
    const ref = resolveFileRef(workspaceRoot, beat.image_path, `beat[${index}].image_path`);
    if (!ref) throw new VideoError(`beat[${index}]: image_path missing`, 2);
    return { kind: "image", path: ref.path, sha256: ref.sha256, slot: beat.image_slot };
  }

  const slot = beat.image_slot;
  if (!slot) {
    throw new VideoError(`beat[${index}]: image_slot required`, 2);
  }

  // compare_b may pull from other product or baseline
  if (beat.role === "compare_b" && compare) {
    if (compare.mode === "vs_product" && compare.other) {
      const img = compare.other.images[slot] ?? compare.other.images.near;
      if (!img) {
        throw new VideoError(`beat[${index}]: compare other product missing ${slot}`, 3);
      }
      return { kind: "image", path: img.path, sha256: img.sha256, slot };
    }
    if (compare.baseline_image) {
      return {
        kind: "image",
        path: compare.baseline_image.path,
        sha256: compare.baseline_image.sha256,
        slot: null,
      };
    }
  }

  const img = product.images[slot];
  if (!img) {
    throw new VideoError(`beat[${index}]: product image slot ${slot} is empty`, 3);
  }
  return { kind: "image", path: img.path, sha256: img.sha256, slot };
}

function preferredCoverSlot(input: VideoInput, product: ProductFreeze): ImageSlot | null {
  if (input.cover.source === "near" || input.cover.source === "wear" || input.cover.source === "detail") {
    return input.cover.source;
  }
  if (input.cover.source === "auto") {
    if (product.images.wear) return "wear";
    if (product.images.near) return "near";
    if (product.images.detail) return "detail";
  }
  return null;
}

export function resolveVideo(workspaceRoot: string, input: VideoInput): VideoSnapshot {
  const warnings: string[] = [];
  const productSummary = findProductById(workspaceRoot, input.product_id);
  if (!productSummary) {
    throw new VideoError(`product_id not found: ${input.product_id}`, 3);
  }
  if (input.options.require_ready && productSummary.meta.status !== "ready") {
    throw new VideoError(
      `product ${input.product_id} status=${String(productSummary.meta.status)} (require_ready)`,
      3,
    );
  }
  if (
    input.options.require_include_in_external &&
    productSummary.meta.include_in_external !== true
  ) {
    throw new VideoError(
      `product ${input.product_id} include_in_external is not true`,
      3,
    );
  }

  const product = freezeProduct(workspaceRoot, productSummary, input.options.require_images);

  let compare: VideoSnapshot["compare"] = null;
  if (input.purpose === "compare" && input.compare) {
    let other: NonNullable<VideoSnapshot["compare"]>["other"] = null;
    if (input.compare.mode === "vs_product") {
      if (input.compare.other_product_id == null) {
        throw new VideoError("compare.other_product_id required", 2);
      }
      if (input.compare.other_product_id === input.product_id) {
        throw new VideoError("compare.other_product_id must differ from product_id", 2);
      }
      const otherSummary = findProductById(workspaceRoot, input.compare.other_product_id);
      if (!otherSummary) {
        throw new VideoError(
          `compare other product not found: ${input.compare.other_product_id}`,
          3,
        );
      }
      const frozenOther = freezeProduct(workspaceRoot, otherSummary, ["near"]);
      other = {
        product_id: frozenOther.product_id,
        slug: frozenOther.slug,
        batch: frozenOther.batch,
        display_name: input.compare.other_label ?? frozenOther.display_name,
        source_meta_sha256: frozenOther.source_meta_sha256,
        images: frozenOther.images,
      };
    }
    const baseline = resolveFileRef(
      workspaceRoot,
      input.compare.baseline_image_path,
      "compare.baseline_image_path",
    );
    compare = {
      mode: input.compare.mode,
      baseline_label: input.compare.baseline_label,
      baseline_image: baseline,
      other_product_id: input.compare.other_product_id,
      other_label: input.compare.other_label,
      other,
    };
  }

  // audio freeze
  let bgm: VideoSnapshot["audio_plan"]["bgm"] = null;
  if (input.audio.bgm?.path) {
    const ref = resolveFileRef(workspaceRoot, input.audio.bgm.path, "audio.bgm.path");
    if (!ref) throw new VideoError("audio.bgm.path missing", 2);
    bgm = {
      path: ref.path,
      sha256: ref.sha256,
      volume: input.audio.bgm.volume,
      license_note: input.audio.bgm.license_note,
    };
  }
  let voiceover: VideoSnapshot["audio_plan"]["voiceover"] = null;
  if (input.audio.voiceover?.path) {
    const ref = resolveFileRef(workspaceRoot, input.audio.voiceover.path, "audio.voiceover.path");
    if (!ref) throw new VideoError("audio.voiceover.path missing", 2);
    voiceover = {
      path: ref.path,
      sha256: ref.sha256,
      volume: input.audio.voiceover.volume,
    };
  }
  if (input.audio.tts) {
    warnings.push("tts configured but engine not implemented in v1; ignored for render");
  }

  const boxFor = (style: VideoInput["captions"]["style"]) =>
    captionBox(input.platform, input.target.width, input.target.height, style);

  let t = 0;
  const timeline: TimelineShot[] = input.script.beats.map((beat, index) => {
    const source = resolveBeatSource(workspaceRoot, input, product, compare, beat, index);
    const shot: TimelineShot = {
      index,
      role: beat.role,
      t_start: t,
      t_end: t + beat.duration_sec,
      duration_sec: beat.duration_sec,
      text: beat.text,
      motion: beat.motion,
      source,
      caption_box: boxFor(
        beat.role === "hook" && input.captions.style === "center_hook"
          ? "center_hook"
          : input.captions.style,
      ),
      render_trace: {
        engine: null,
        provider: null,
        request_id: null,
        fallback_used: false,
      },
    };
    t += beat.duration_sec;
    return shot;
  });

  const coverSlot = preferredCoverSlot(input, product);
  let frameAt = input.cover.frame_at_sec;
  if (input.cover.source === "auto" && frameAt == null) {
    frameAt = timeline[0]?.t_start ?? 0;
  }

  return {
    schema: "wanghai.promo.video-snapshot",
    schema_version: 1,
    video_id: input.video_id,
    frozen_at: utcNow(),
    from_input_sha256: sha256Json(input),
    platform: input.platform,
    purpose: input.purpose,
    locale: input.locale,
    mode: input.mode,
    engine: input.render.engine,
    fallback: input.render.fallback,
    api: input.render.api ?? null,
    target: input.target,
    product,
    compare,
    script: { hook: input.script.hook, cta: input.script.cta },
    captions: input.captions,
    cover_plan: {
      source: input.cover.source,
      frame_at_sec: frameAt,
      preferred_slot: coverSlot,
    },
    audio_plan: {
      require_bgm: input.audio.mix.require_bgm,
      loop_bgm: input.audio.mix.loop_bgm,
      bgm,
      tts: input.audio.tts,
      voiceover,
      music_duck_db: input.audio.mix.music_duck_db,
    },
    timeline,
    warnings,
  };
}
