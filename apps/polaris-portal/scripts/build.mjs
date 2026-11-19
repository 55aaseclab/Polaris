import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const distRoot = resolve(import.meta.dirname, "../dist");

async function assetVersion(fileName) {
  const body = await readFile(resolve(distRoot, fileName));
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

function addAssetVersion(html, fileName, version) {
  const assetPath = `/shell/${fileName}`;
  const pattern = new RegExp(`${assetPath}(?!\\?v=)`, "g");
  const rewritten = html.replace(pattern, `${assetPath}?v=${version}`);
  if (rewritten === html) {
    throw new Error(`Portal build output does not reference ${assetPath}`);
  }
  return rewritten;
}

const [html, javascriptVersion, cssVersion] = await Promise.all([
  readFile(resolve(distRoot, "index.html"), "utf8"),
  assetVersion("shell.js"),
  assetVersion("shell.css"),
]);

const versionedHtml = addAssetVersion(
  addAssetVersion(html, "shell.js", javascriptVersion),
  "shell.css",
  cssVersion,
);

await writeFile(resolve(distRoot, "index.html"), versionedHtml, "utf8");
