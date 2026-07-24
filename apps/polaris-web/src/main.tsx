import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthingProvider } from "./lib/authing";
import { type Language, readStoredLanguage } from "./lib/language";
import { initTelemetry, trackTelemetryEvent } from "./lib/telemetry";
import "./index.css";

initTelemetry();

function Root() {
  const [language, setLanguage] = React.useState<Language>(() => readStoredLanguage());

  return (
    <AuthingProvider>
      <BrowserRouter>
        <App language={language} setLanguage={setLanguage} />
      </BrowserRouter>
    </AuthingProvider>
  );
}

trackTelemetryEvent("session_started", {
  category: "product",
  first_run: !window.localStorage.getItem("polaris_session_seen"),
});
window.localStorage.setItem("polaris_session_seen", "1");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
