import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "@playwright/test";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const PLAYWRIGHT_WEB_PORT = 14174;
const PLAYWRIGHT_API_PORT = 18798;
const PLAYWRIGHT_EXECUTOR_PORT = 18799;
const PLAYWRIGHT_EXECUTOR_SECRET = "playwright-executor-shared-secret";

loadEnv({ path: path.resolve(DIRNAME, ".env.local") });

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PLAYWRIGHT_WEB_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `POLARIS_EXECUTOR_SHARED_SECRET=${PLAYWRIGHT_EXECUTOR_SECRET} pnpm --filter polaris run polaris -- executor ${PLAYWRIGHT_EXECUTOR_PORT}`,
      url: `http://127.0.0.1:${PLAYWRIGHT_EXECUTOR_PORT}/health`,
      reuseExistingServer: false,
      cwd: path.resolve(DIRNAME, "../.."),
    },
    {
      command: `POLARIS_EXECUTOR_BASE_URL=http://127.0.0.1:${PLAYWRIGHT_EXECUTOR_PORT} POLARIS_EXECUTOR_SHARED_SECRET=${PLAYWRIGHT_EXECUTOR_SECRET} pnpm --filter polaris run polaris -- portal ${PLAYWRIGHT_API_PORT} 0.0.0.0`,
      url: `http://127.0.0.1:${PLAYWRIGHT_API_PORT}`,
      reuseExistingServer: false,
      cwd: path.resolve(DIRNAME, "../.."),
    },
    {
      command: `POLARIS_WEB_PORT=${PLAYWRIGHT_WEB_PORT} POLARIS_API_PROXY_TARGET=http://127.0.0.1:${PLAYWRIGHT_API_PORT} pnpm --filter polaris-web exec vite --host 0.0.0.0 --port ${PLAYWRIGHT_WEB_PORT}`,
      url: `http://127.0.0.1:${PLAYWRIGHT_WEB_PORT}`,
      reuseExistingServer: true,
      cwd: path.resolve(DIRNAME, "../.."),
    },
  ],
});
