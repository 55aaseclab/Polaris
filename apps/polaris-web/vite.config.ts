import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const port = Number(process.env.POLARIS_WEB_PORT || "4173");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: { port },
});
