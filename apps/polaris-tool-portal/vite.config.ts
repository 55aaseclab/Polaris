import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const appRoot = path.dirname(fileURLToPath(import.meta.url));

function redirectRootToTools(): Plugin {
  return {
    name: "redirect-root-to-tools",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url || "/", "http://polaris-tool-portal.local");
        if (url.pathname === "/") {
          res.statusCode = 302;
          res.setHeader("location", `/tools${url.search}`);
          res.end();
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  base: command === "serve" ? "/" : "/tools/",
  plugins: [redirectRootToTools(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.join(appRoot, "src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5179,
    proxy: {
      "/api": {
        target: process.env.POLARIS_API_ORIGIN || "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: path.join(appRoot, "dist"),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: "tools.js",
        chunkFileNames: "tools-[name].js",
        assetFileNames: (assetInfo) =>
          assetInfo.name?.endsWith(".css") ? "tools.css" : "assets/[name]-[hash][extname]",
      },
    },
  },
}));
