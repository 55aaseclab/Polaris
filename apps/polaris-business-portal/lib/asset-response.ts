export interface AssetResponseOptions {
  contentType: string;
  fileName: string;
  etag?: string;
  frameAncestorsDirective?: string;
  lastModified?: string;
}

export function assetResponseHeaders(
  options: AssetResponseOptions,
): Record<string, string> {
  const mediaType = options.contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const headers: Record<string, string> = {
    "cache-control": "private, no-store",
    "content-type": options.contentType,
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
  };
  if (options.etag) headers.etag = options.etag;
  if (options.lastModified) headers["last-modified"] = options.lastModified;

  if (mediaType === "text/html") {
    headers["content-disposition"] = attachmentDisposition(options.fileName);
    headers["content-security-policy"] = sandboxPolicy(options.frameAncestorsDirective);
  } else if (mediaType === "image/svg+xml" || mediaType === "application/pdf") {
    // Keep SVG and PDF previews usable, but prevent scripts and external
    // navigation if a browser opens the response as a document.
    headers["content-security-policy"] = sandboxPolicy(options.frameAncestorsDirective);
  }
  return headers;
}

function attachmentDisposition(fileName: string): string {
  const safeName = fileName.replace(/[\r\n"\\]/gu, "_").trim() || "download";
  return `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function sandboxPolicy(frameAncestorsDirective = "frame-ancestors 'self'"): string {
  return `sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; ${frameAncestorsDirective}; style-src 'unsafe-inline'; img-src data:`;
}
