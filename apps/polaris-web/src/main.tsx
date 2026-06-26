import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { enUS, zhCN, zhTW } from "@clerk/localizations";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
const publishableKey = env?.VITE_CLERK_PUBLISHABLE_KEY?.trim();
const LANGUAGE_STORAGE_KEY = "polaris-language";

if (!publishableKey) {
  throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required");
}

function resolvePreferredLanguages(): string[] {
  if (typeof window === "undefined") {
    return ["en"];
  }
  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (stored === "zh") {
    return ["zh-CN"];
  }
  if (stored === "en") {
    return ["en"];
  }
  if (Array.isArray(window.navigator.languages) && window.navigator.languages.length > 0) {
    return window.navigator.languages;
  }
  return [window.navigator.language];
}

function resolveClerkLocalization() {
  for (const language of resolvePreferredLanguages()) {
    const normalized = language.toLowerCase();
    if (
      normalized.startsWith("zh-tw")
      || normalized.startsWith("zh-hk")
      || normalized.startsWith("zh-mo")
      || normalized.includes("hant")
    ) {
      return zhTW;
    }
    if (normalized.startsWith("zh")) {
      return zhCN;
    }
    if (normalized.startsWith("en")) {
      return enUS;
    }
  }
  return enUS;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ClerkProvider
      publishableKey={publishableKey}
      localization={resolveClerkLocalization()}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
      afterSignOutUrl="/sign-in"
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ClerkProvider>
  </React.StrictMode>,
);
