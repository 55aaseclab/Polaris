import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "@playwright/test";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const PLAYWRIGHT_WEB_PORT = 4174;
const PLAYWRIGHT_API_PORT = 8788;

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
      command: `pnpm --filter polaris run polaris -- portal ${PLAYWRIGHT_API_PORT} 0.0.0.0`,
      url: `http://127.0.0.1:${PLAYWRIGHT_API_PORT}`,
      reuseExistingServer: false,
      cwd: path.resolve(DIRNAME, "../.."),
    },
    {
      command: `POLARIS_WEB_PORT=${PLAYWRIGHT_WEB_PORT} POLARIS_API_PROXY_TARGET=http://127.0.0.1:${PLAYWRIGHT_API_PORT} pnpm --filter polaris-web run dev:host`,
      url: `http://127.0.0.1:${PLAYWRIGHT_WEB_PORT}`,
      reuseExistingServer: false,
      cwd: path.resolve(DIRNAME, "../.."),
    },
  ],
});
