export function formatRunDateTime(timestamp: string): string {
  return timestamp.slice(0, 16).replace("T", " ");
}
