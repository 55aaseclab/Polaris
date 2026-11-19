import { portalBase } from "../portal-path.js";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { interpolate, LANGUAGE_STORAGE_KEY, messages, type Language, type MessageKey } from "./messages.js";

type I18nValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  toggleLanguage: () => void;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nValue | null>(null);

function initialLanguage(): Language {
  try {
    if (portalBase()) {
      const cookie = document.cookie.match(/(?:^|;\s*)praxis_locale=(en|zh)(?:;|$)/);
      if (cookie) return cookie[1] === "zh" ? "zh" : "en";
      const shared = window.localStorage.getItem("praxis.locale");
      if (shared === "zh" || shared === "en") return shared;
    }
    return window.localStorage.getItem(LANGUAGE_STORAGE_KEY) === "zh" ? "zh" : "en";
  } catch {
    return "en";
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);
  const setLanguage = (next: Language) => {
    setLanguageState(next);
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
      if (portalBase()) {
        window.localStorage.setItem("praxis.locale", next);
        document.cookie = `praxis_locale=${next}; Path=/; SameSite=Lax; Max-Age=31536000${location.protocol === "https:" ? "; Secure" : ""}`;
      }
    } catch { /* Keep the current language when persistence is unavailable. */ }
  };
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === LANGUAGE_STORAGE_KEY || (portalBase() && event.key === "praxis.locale")) {
        setLanguageState(initialLanguage());
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const value = useMemo<I18nValue>(() => ({
    language,
    setLanguage,
    toggleLanguage: () => setLanguage(language === "zh" ? "en" : "zh"),
    t: (key, values) => interpolate(messages[language][key], values),
  }), [language]);
  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
