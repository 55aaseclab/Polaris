import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
var apiTarget = process.env.POLARIS_API_PROXY_TARGET || "http://127.0.0.1:8787";
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    server: {
        port: 4173,
        proxy: {
            "/api": apiTarget,
        },
    },
});
