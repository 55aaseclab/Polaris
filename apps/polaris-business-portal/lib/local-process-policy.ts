export const THUMBNAIL_CONVERSION_TIMEOUT_MS = 5_000;
export const THUMBNAIL_CONVERSION_MAX_BUFFER_BYTES = 64 * 1024;

export const THUMBNAIL_CONVERSION_OPTIONS = {
  encoding: "utf-8" as const,
  maxBuffer: THUMBNAIL_CONVERSION_MAX_BUFFER_BYTES,
  timeout: THUMBNAIL_CONVERSION_TIMEOUT_MS,
};

/** Bound ImageMagick before it decodes an untrusted tenant image. */
export function thumbnailConversionArgs(sourcePath: string, thumbnailPath: string): string[] {
  return [
    "-limit", "memory", "128MiB",
    "-limit", "map", "256MiB",
    "-limit", "disk", "512MiB",
    sourcePath,
    "-auto-orient",
    "-thumbnail", "160x160^",
    "-gravity", "center",
    "-extent", "160x160",
    "-quality", "72",
    thumbnailPath,
  ];
}
