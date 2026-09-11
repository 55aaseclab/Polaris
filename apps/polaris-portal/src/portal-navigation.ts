export function historyFrom(state: unknown): string {
  if (state && typeof state === "object" && "from" in state && typeof (state as { from?: unknown }).from === "string") {
    return (state as { from: string }).from;
  }
  return "";
}

export function normalizeHistoryPath(path: string): string {
  const pathname = path.split("?")[0] || "/";
  return pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname || "/";
}

export function canPopTo(state: unknown, fallback: string): boolean {
  const from = historyFrom(state);
  return Boolean(from) && normalizeHistoryPath(from) === normalizeHistoryPath(fallback);
}

export function backTo(fallback: string, navigate: (path: string, replace?: boolean) => void): void {
  if (canPopTo(window.history.state, fallback)) {
    window.history.back();
    return;
  }
  navigate(fallback);
}
