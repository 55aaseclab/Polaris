import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { enUS, zhCN } from "@clerk/localizations";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { type Language, readStoredLanguage } from "./lib/language";
import "./index.css";

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
const publishableKey = env?.VITE_CLERK_PUBLISHABLE_KEY?.trim();

if (!publishableKey) {
  throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required");
}

function resolveClerkLocalization(language: Language) {
  return language === "zh" ? zhCN : enUS;
}

function Root() {
  const [language, setLanguage] = React.useState<Language>(() => readStoredLanguage());

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      localization={resolveClerkLocalization(language)}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
      afterSignOutUrl="/sign-in"
    >
      <BrowserRouter>
        <App language={language} setLanguage={setLanguage} />
      </BrowserRouter>
    </ClerkProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
