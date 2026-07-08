import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

const apiTarget = process.env.POLARIS_API_PROXY_TARGET?.trim() || "http://127.0.0.1:8787";
const port = Number(process.env.POLARIS_WEB_PORT || "4173");
const analyze = process.env.ANALYZE === "true";

export default defineConfig({
  plugins: [
    react(),
    ...(analyze
      ? [visualizer({
          filename: "dist/stats.html",
          gzipSize: true,
          brotliSize: true,
          template: "treemap",
          open: false,
        })]
      : []),
  ],
  build: {
    sourcemap: analyze,
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("@clerk/")) {
              return "vendor-clerk";
            }
            if (id.includes("@radix-ui/")) {
              return "vendor-radix";
            }
            if (
              id.includes("/react/")
              || id.includes("/react-dom/")
              || id.includes("react-router")
              || id.includes("scheduler")
            ) {
              return "vendor-react";
            }
            if (id.includes("lucide-react")) {
              return "vendor-icons";
            }
          }
          if (id.includes("/src/features/admin-paseo-tab.tsx")) {
            return "admin-paseo";
          }
          if (id.includes("/src/features/workspace-paseo-pane.tsx")) {
            return "workspace-paseo";
          }
          if (id.includes("/src/routes/sign-in-page.tsx")
            || id.includes("/src/routes/sign-up-page.tsx")) {
            return "route-auth";
          }
          return undefined;
        },
      },
    },
  },
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
