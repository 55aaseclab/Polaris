var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var _a;
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
var apiTarget = ((_a = process.env.POLARIS_API_PROXY_TARGET) === null || _a === void 0 ? void 0 : _a.trim()) || "http://127.0.0.1:8787";
var port = Number(process.env.POLARIS_WEB_PORT || "4173");
var analyze = process.env.ANALYZE === "true";
export default defineConfig({
    plugins: __spreadArray([
        react()
    ], (analyze
        ? [visualizer({
                filename: "dist/stats.html",
                gzipSize: true,
                brotliSize: true,
                template: "treemap",
                open: false,
            })]
        : []), true),
    build: {
        sourcemap: analyze,
        chunkSizeWarningLimit: 650,
        rollupOptions: {
            output: {
                manualChunks: function (id) {
                    if (id.includes("node_modules")) {
                        if (id.includes("@clerk/")) {
                            return "vendor-clerk";
                        }
                        if (id.includes("@radix-ui/")) {
                            return "vendor-radix";
                        }
                        if (id.includes("/react/")
                            || id.includes("/react-dom/")
                            || id.includes("react-router")
                            || id.includes("scheduler")) {
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
        port: port,
        proxy: {
            "/api": apiTarget,
        },
    },
});
