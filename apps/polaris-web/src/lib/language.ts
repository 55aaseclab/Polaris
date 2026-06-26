export type Language = "en" | "zh";

export const LANGUAGE_STORAGE_KEY = "polaris-language";

export function readStoredLanguage(): Language {
  if (typeof window === "undefined") {
    return "zh";
  }
  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return stored === "en" ? "en" : "zh";
}

export function writeStoredLanguage(language: Language): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
}
