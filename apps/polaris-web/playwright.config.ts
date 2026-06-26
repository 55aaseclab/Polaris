import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "@playwright/test";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));

loadEnv({ path: path.resolve(DIRNAME, ".env.local") });

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm --filter polaris run polaris -- portal 8787 0.0.0.0",
      url: "http://127.0.0.1:8787",
      reuseExistingServer: false,
      cwd: path.resolve(DIRNAME, "../.."),
    },
    {
      command: "pnpm --filter polaris-web run dev:host",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      cwd: path.resolve(DIRNAME, "../.."),
    },
  ],
});
