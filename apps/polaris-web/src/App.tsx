import { useEffect } from "react";

function paseoUrl(): string {
  return import.meta.env.VITE_PASEO_APP_BASE_URL?.trim() || "/";
}

export default function App() {
  useEffect(() => {
    window.location.replace(paseoUrl());
  }, []);

  return null;
}
