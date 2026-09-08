export function normalizeAllowedDevOrigins(value: string | undefined): string[] {
  return String(value ?? "")
    .split(/\s+/u)
    .map((item) => item.trim())
    .map((item) => {
      try {
        return new URL(item).hostname;
      } catch {
        return item;
      }
    })
    .filter(Boolean);
}
