"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ADMIN_PORTAL_DEFAULT_LOCALE,
  ADMIN_PORTAL_LOCALE_COOKIE,
  ADMIN_PORTAL_LOCALE_STORAGE_KEY,
  type AdminPortalLocale,
  coerceAdminPortalLocale,
  getAdminPortalList,
  getAdminPortalMessage,
  getAdminPortalText,
  translateAdminPortalInline,
  translateAdminPortalInlineText,
} from "@/lib/i18n";

type I18nContextValue = {
  locale: AdminPortalLocale;
  setLocale: (next: AdminPortalLocale) => void;
  t: (
    path: string,
    values?: Record<string, string | number | boolean>,
    fallback?: string,
  ) => string;
  tm: <T = unknown>(path: string, fallback?: T) => T;
  ts: (
    source: string,
    values?: Record<string, string | number | boolean>,
  ) => string;
  formatDateTime: (
    value: string | number | Date | null | undefined,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  formatNumber: (
    value: number,
    options?: Intl.NumberFormatOptions,
  ) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale: AdminPortalLocale;
}) {
  const [locale, setLocaleState] = useState<AdminPortalLocale>(initialLocale);
  const textSourceMapRef = useRef<WeakMap<Text, string>>(new WeakMap());
  const attrSourceMapRef = useRef<WeakMap<Element, Map<string, string>>>(new WeakMap());

  const translateDom = useCallback((root: ParentNode) => {
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
      textNodes.push(current as Text);
      current = walker.nextNode();
    }

    for (const node of textNodes) {
      const parent = node.parentElement;
      if (!parent) continue;
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"].includes(parent.tagName)) continue;
      const raw = textSourceMapRef.current.get(node) ?? node.nodeValue ?? "";
      if (!raw.trim()) continue;
      textSourceMapRef.current.set(node, raw);
      const nextValue = locale === "en-US"
        ? translateAdminPortalInlineText(locale, raw)
        : raw;
      if (node.nodeValue !== nextValue) node.nodeValue = nextValue;
    }

    const elements = (root instanceof Element ? [root, ...Array.from(root.querySelectorAll("*"))] : Array.from((root as Document).querySelectorAll("*")));
    for (const element of elements) {
      const attributes = ["aria-label", "title", "placeholder"] as const;
      let stored = attrSourceMapRef.current.get(element);
      if (!stored) {
        stored = new Map();
        attrSourceMapRef.current.set(element, stored);
      }
      for (const attr of attributes) {
        const currentValue = element.getAttribute(attr);
        if (currentValue === null) continue;
        if (!stored.has(attr)) stored.set(attr, currentValue);
        const sourceValue = stored.get(attr) ?? currentValue;
        const nextValue = locale === "en-US"
          ? translateAdminPortalInlineText(locale, sourceValue)
          : sourceValue;
        if (currentValue !== nextValue) element.setAttribute(attr, nextValue);
      }
    }
  }, [locale]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(ADMIN_PORTAL_LOCALE_STORAGE_KEY);
      if (stored) {
        const next = coerceAdminPortalLocale(stored);
        setLocaleState((current) => current === next ? current : next);
      }
    } catch {
      // localStorage can be unavailable
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      window.localStorage.setItem(ADMIN_PORTAL_LOCALE_STORAGE_KEY, locale);
    } catch {
      // localStorage can be unavailable
    }
    document.cookie = `${ADMIN_PORTAL_LOCALE_COOKIE}=${encodeURIComponent(locale)}; path=/; max-age=31536000; samesite=lax`;
  }, [locale]);

  useEffect(() => {
    const root = document.body;
    translateDom(root);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          const node = mutation.target;
          if (node instanceof Text) {
            const parent = node.parentElement;
            if (!parent) continue;
            if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"].includes(parent.tagName)) continue;
            const raw = textSourceMapRef.current.get(node) ?? node.nodeValue ?? "";
            if (!raw.trim()) continue;
            textSourceMapRef.current.set(node, raw);
            const nextValue = translateAdminPortalInlineText(locale, raw);
            if (node.nodeValue !== nextValue) node.nodeValue = nextValue;
          }
        }
        if (mutation.type === "childList") {
          for (const added of Array.from(mutation.addedNodes)) {
            if (added.nodeType === Node.TEXT_NODE) {
              const node = added as Text;
              const raw = textSourceMapRef.current.get(node) ?? node.nodeValue ?? "";
              if (!raw.trim()) continue;
              textSourceMapRef.current.set(node, raw);
              const nextValue = translateAdminPortalInlineText(locale, raw);
              if (node.nodeValue !== nextValue) node.nodeValue = nextValue;
            } else if (added instanceof Element) {
              translateDom(added);
            }
          }
        }
      }
    });
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [locale, translateDom]);

  const setLocale = useCallback((next: AdminPortalLocale) => {
    setLocaleState(next);
  }, []);

  const t = useCallback((
    path: string,
    values?: Record<string, string | number | boolean>,
    fallback?: string,
  ) => getAdminPortalText(locale, path, values, fallback), [locale]);

  const tm = useCallback(<T,>(path: string, fallback?: T): T => {
    const value = getAdminPortalMessage(locale, path);
    if (value === undefined) return fallback as T;
    return value as T;
  }, [locale]);

  const ts = useCallback((
    source: string,
    values?: Record<string, string | number | boolean>,
  ) => translateAdminPortalInline(locale, source, values), [locale]);

  const formatDateTime = useCallback((
    value: string | number | Date | null | undefined,
    options: Intl.DateTimeFormatOptions = {},
  ): string => {
    if (value === null || value === undefined) return "";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(locale, options).format(date);
  }, [locale]);

  const formatNumber = useCallback((
    value: number,
    options: Intl.NumberFormatOptions = {},
  ): string => new Intl.NumberFormat(locale, options).format(value), [locale]);

  const contextValue = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    t,
    tm,
    ts,
    formatDateTime,
    formatNumber,
  }), [formatDateTime, formatNumber, locale, setLocale, t, tm, ts]);

  return (
    <I18nContext.Provider value={contextValue}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return context;
}

export function useLocaleOptions() {
  const { t } = useI18n();
  return useMemo(() => [
    { label: t("language.zh", undefined, "中文"), value: "zh-CN" as const },
    { label: t("language.en", undefined, "English"), value: "en-US" as const },
  ], [t]);
}
