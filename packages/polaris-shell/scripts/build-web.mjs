import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist", "web");

mkdirSync(output, { recursive: true });
await build({
  bundle: true,
  entryPoints: [resolve(root, "src", "web", "main.ts")],
  format: "esm",
  outfile: resolve(output, "shell.js"),
  platform: "browser",
  target: "es2022",
});
copyFileSync(resolve(root, "src", "web", "index.html"), resolve(output, "index.html"));
copyFileSync(resolve(root, "src", "web", "styles.css"), resolve(output, "shell.css"));
