import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./index.css";
import { I18nProvider } from "./i18n/index.js";

createRoot(document.getElementById("app")!).render(
  <StrictMode><I18nProvider><App /></I18nProvider></StrictMode>,
);
