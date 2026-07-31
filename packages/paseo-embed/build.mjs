import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = import.meta.dirname;
const sourceDir = resolve(packageRoot, "src");
const outputDir = resolve(packageRoot, "dist");

await rm(outputDir, { force: true, recursive: true });
await mkdir(outputDir, { recursive: true });
await Promise.all(
  ["index.js", "index.d.ts"].map((fileName) =>
    copyFile(resolve(sourceDir, fileName), resolve(outputDir, fileName)),
  ),
);
