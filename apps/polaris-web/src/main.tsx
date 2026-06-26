import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
const publishableKey = env?.VITE_CLERK_PUBLISHABLE_KEY?.trim();

if (!publishableKey) {
  throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ClerkProvider
      publishableKey={publishableKey}
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
