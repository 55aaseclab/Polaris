export type ArtifactPreviewKind =
  | "audio"
  | "code"
  | "image"
  | "json"
  | "markdown"
  | "pdf"
  | "table"
  | "text"
  | "video"
  | "binary";

const EXTENSION_KINDS: Record<string, ArtifactPreviewKind> = {
  ".aac": "audio",
  ".flac": "audio",
  ".gif": "image",
  ".jpeg": "image",
  ".jpg": "image",
  ".m4a": "audio",
  ".md": "markdown",
  ".mp3": "audio",
  ".mp4": "video",
  ".pdf": "pdf",
  ".png": "image",
  ".svg": "image",
  ".tsv": "table",
  ".wav": "audio",
  ".webm": "video",
  ".webp": "image",
  ".xlsx": "binary",
  ".xls": "binary",
  ".xml": "code",
  ".yaml": "code",
  ".yml": "code",
  ".json": "json",
  ".csv": "table",
  ".css": "code",
  ".html": "code",
  ".js": "code",
  ".jsx": "code",
  ".log": "text",
  ".py": "code",
  ".sh": "code",
  ".sql": "code",
  ".tsx": "code",
  ".txt": "text",
  ".ts": "code",
};

const OUTPUT_FIELD_KINDS: Record<string, ArtifactPreviewKind> = {
  pdfref: "pdf",
  markdownref: "markdown",
  manifestref: "json",
};

export function artifactPreviewKind(name: string): ArtifactPreviewKind {
  const lower = name.toLocaleLowerCase();
  if (OUTPUT_FIELD_KINDS[lower]) return OUTPUT_FIELD_KINDS[lower];
  const extension = name.slice(name.lastIndexOf(".")).toLocaleLowerCase();
  return EXTENSION_KINDS[extension] || "binary";
}

export function artifactPreviewSource(content: string): string | null {
  const value = content.trim();
  if (value.startsWith("data:") || value.startsWith("blob:") || /^https?:\/\//u.test(value)) {
    return value;
  }
  return null;
}

export function artifactPreviewUrl(runId: string, artifactId: string): string {
  return `/api/workflow-runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

export function workspaceFilePreviewUrl(runId: string, relativePath: string): string {
  return `/api/workflow-runs/${encodeURIComponent(runId)}/files?path=${encodeURIComponent(relativePath)}`;
}

export function formatJsonArtifact(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
