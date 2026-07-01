import fs from "node:fs";

const root = "/opt/paseo/packages/app/dist";
const baseUrl = (process.env.BASE_URL || "").replace(/\/+$/, "");

if (!baseUrl) {
  process.exit(0);
}

const prefix = `${baseUrl}/`;
const indexPath = `${root}/index.html`;
const manifestPath = `${root}/manifest.json`;
const escapedBasePath = baseUrl
  .replace(/^\/+/, "")
  .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const htmlRootAssetPattern = new RegExp(
  `(href|src)="/(?!${escapedBasePath}/|/)`,
  "g",
);
const cssRootAssetPattern = new RegExp(`url\\(/(?!${escapedBasePath}/|/)`, "g");

const rewriteIndex = (value) =>
  value
    .replace(htmlRootAssetPattern, `$1="${prefix}`)
    .replace(cssRootAssetPattern, `url(${prefix}`);

fs.writeFileSync(indexPath, rewriteIndex(fs.readFileSync(indexPath, "utf8")), "utf8");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

if (manifest.id === "/") manifest.id = prefix;
if (manifest.start_url === "/") manifest.start_url = prefix;
if (manifest.scope === "/") manifest.scope = prefix;

if (Array.isArray(manifest.icons)) {
  manifest.icons = manifest.icons.map((icon) =>
    icon && typeof icon.src === "string" && icon.src.startsWith("/")
      ? { ...icon, src: `${baseUrl}${icon.src}` }
      : icon,
  );
}

fs.writeFileSync(
  manifestPath,
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
