import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.POLARIS_API_PROXY_TARGET?.trim() || "http://127.0.0.1:8787";
const port = Number(process.env.POLARIS_WEB_PORT || "4173");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port,
    proxy: {
      "/api": apiTarget,
    },
  },
});
