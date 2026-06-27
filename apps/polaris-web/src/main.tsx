import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { enUS, zhCN } from "@clerk/localizations";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import {
  clerkDomain,
  clerkProxyUrl,
  clerkPublishableKey,
  clerkSignInUrl,
  clerkSignUpUrl,
} from "./lib/clerk";
import { type Language, readStoredLanguage } from "./lib/language";
import "./index.css";

const publishableKey = clerkPublishableKey();
const domain = clerkDomain();
const proxyUrl = clerkProxyUrl();

function resolveClerkLocalization(language: Language) {
  return language === "zh" ? zhCN : enUS;
}

function Root() {
  const [language, setLanguage] = React.useState<Language>(() => readStoredLanguage());

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      localization={resolveClerkLocalization(language)}
      {...(domain ? { domain } : {})}
      {...(proxyUrl ? { proxyUrl } : {})}
      signInUrl={clerkSignInUrl()}
      signUpUrl={clerkSignUpUrl()}
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
      afterSignOutUrl={clerkSignInUrl()}
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
