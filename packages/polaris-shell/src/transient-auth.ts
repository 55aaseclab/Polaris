function cookieAttributes(): string {
  return `path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}

function readCookieValue(key: string): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const entry = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${key}=`));
  if (!entry) {
    return null;
  }
  return decodeURIComponent(entry.slice(key.length + 1).trim()) || null;
}

function writeCookieValue(key: string, value: string): void {
  if (typeof document === "undefined") {
    return;
  }
  document.cookie = `${key}=${encodeURIComponent(value)}; ${cookieAttributes()}`;
}

function clearCookieValue(key: string): void {
  if (typeof document === "undefined") {
    return;
  }
  document.cookie = `${key}=; Max-Age=0; ${cookieAttributes()}`;
}

export function readTransientValue(key: string): string | null {
  try {
    const sessionValue = sessionStorage.getItem(key)?.trim();
    if (sessionValue) {
      return sessionValue;
    }
  } catch {
    // Ignore storage availability issues.
  }
  const cookieValue = readCookieValue(key)?.trim();
  if (cookieValue) {
    return cookieValue;
  }
  try {
    return localStorage.getItem(key)?.trim() || null;
  } catch {
    return null;
  }
}

export function writeTransientValue(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Ignore storage availability issues.
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage availability issues.
  }
  writeCookieValue(key, value);
}

export function clearTransientValue(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Ignore storage availability issues.
  }
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage availability issues.
  }
  clearCookieValue(key);
}
