import type { Platform } from "./types.js";

export type PlatformProfile = {
  caption: {
    /** fraction of frame from top for caption top edge */
    y_frac: number;
    h_frac: number;
    x_frac: number;
    w_frac: number;
  };
};

const PROFILES: Record<Platform, PlatformProfile> = {
  douyin: {
    caption: { x_frac: 0.08, y_frac: 0.72, w_frac: 0.84, h_frac: 0.14 },
  },
  xiaohongshu: {
    caption: { x_frac: 0.08, y_frac: 0.7, w_frac: 0.84, h_frac: 0.16 },
  },
  tiktok: {
    caption: { x_frac: 0.08, y_frac: 0.68, w_frac: 0.84, h_frac: 0.16 },
  },
  instagram: {
    caption: { x_frac: 0.08, y_frac: 0.72, w_frac: 0.84, h_frac: 0.14 },
  },
  generic: {
    caption: { x_frac: 0.08, y_frac: 0.72, w_frac: 0.84, h_frac: 0.14 },
  },
};

export function platformProfile(platform: Platform): PlatformProfile {
  return PROFILES[platform];
}

export function captionBox(
  platform: Platform,
  width: number,
  height: number,
  style: "safe_zone_bottom" | "center_hook",
): { x: number; y: number; w: number; h: number } {
  if (style === "center_hook") {
    return {
      x: Math.round(width * 0.1),
      y: Math.round(height * 0.42),
      w: Math.round(width * 0.8),
      h: Math.round(height * 0.16),
    };
  }
  const p = platformProfile(platform).caption;
  return {
    x: Math.round(width * p.x_frac),
    y: Math.round(height * p.y_frac),
    w: Math.round(width * p.w_frac),
    h: Math.round(height * p.h_frac),
  };
}
