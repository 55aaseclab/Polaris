import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { enUS, zhCN } from "@clerk/localizations";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import {
  resolveClerkProviderConfig,
} from "./lib/clerk";
import { type Language, readStoredLanguage } from "./lib/language";
import "./index.css";

function resolveClerkLocalization(language: Language) {
  return language === "zh" ? zhCN : enUS;
}

function Root() {
  const [language, setLanguage] = React.useState<Language>(() => readStoredLanguage());
  const clerkConfig = resolveClerkProviderConfig({
    ...(typeof window !== "undefined"
      ? {
          location: {
            origin: window.location.origin,
            host: window.location.host,
          },
        }
      : {}),
  });

  return (
    <ClerkProvider
      publishableKey={clerkConfig.publishableKey}
      localization={resolveClerkLocalization(language)}
      {...(clerkConfig.proxyUrl ? { proxyUrl: clerkConfig.proxyUrl } : {})}
      {...(clerkConfig.isSatellite
        ? {
            isSatellite: true,
            domain: clerkConfig.domain,
            satelliteAutoSync: false,
          }
        : {})}
      signInUrl={clerkConfig.signInUrl}
      signUpUrl={clerkConfig.signUpUrl}
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
      afterSignOutUrl={clerkConfig.signInUrl}
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
