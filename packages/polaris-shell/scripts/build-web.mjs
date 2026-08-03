import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
copyFileSync(resolve(root, "src", "web", "styles.css"), resolve(output, "shell.css"));
const shellJs = readFileSync(resolve(output, "shell.js"));
const shellCss = readFileSync(resolve(output, "shell.css"));
const buildId = createHash("sha256")
  .update(shellJs)
  .update(shellCss)
  .digest("hex")
  .slice(0, 12);
const html = readFileSync(resolve(root, "src", "web", "index.html"), "utf8")
  .replace("/shell/shell.css", `/shell/shell.css?v=${buildId}`)
  .replace("/shell/shell.js", `/shell/shell.js?v=${buildId}`);
writeFileSync(resolve(output, "index.html"), html);
