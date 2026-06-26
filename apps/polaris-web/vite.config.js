var _a;
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
var apiTarget = ((_a = process.env.POLARIS_API_PROXY_TARGET) === null || _a === void 0 ? void 0 : _a.trim()) || "http://127.0.0.1:8787";
var port = Number(process.env.POLARIS_WEB_PORT || "4173");
export default defineConfig({
    plugins: [react()],
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
