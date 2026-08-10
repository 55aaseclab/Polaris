import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  base: "/shell/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.join(appRoot, "src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5178,
    proxy: {
      "/api": {
        target: process.env.POLARIS_API_ORIGIN || "http://127.0.0.1:8787",
        changeOrigin: true,
      },
      "/g": {
        target: process.env.POLARIS_API_ORIGIN || "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  define: {
    __POLARIS_PORTAL_MODE__: JSON.stringify(mode),
  },
  build: {
    outDir: path.join(appRoot, "dist"),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: "shell.js",
        chunkFileNames: "shell-[name].js",
        assetFileNames: (assetInfo) =>
          assetInfo.name?.endsWith(".css") ? "shell.css" : "assets/[name]-[hash][extname]",
      },
    },
  },
}));
