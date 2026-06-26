import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 4173,
    allowedHosts: ["595f833d.r5.cpolar.top"],
    proxy: {
      "/api": apiTarget,
    },
  },
});
