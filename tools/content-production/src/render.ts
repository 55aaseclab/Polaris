import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PACKAGE_ROOT } from "@polaris/business-core";
import { ensureDir, resolveUnderWorkspace, TEMPLATES_DIR } from "./paths.js";
import { CatalogError, type CatalogSnapshot, type ImageSlot, type SnapshotPage } from "./types.js";

const FONT_PATH = path.join(PACKAGE_ROOT, "assets", "fonts", "NotoSansCJKsc-Regular.otf");

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[char] ?? char;
  });
}

function documentFontFaceCss(): string {
  if (!fs.existsSync(FONT_PATH)) {
    return "";
  }
  const fontUrl = pathToFileURL(FONT_PATH).href;
  return `@font-face {
    font-family: "WanghaiDocSans";
    src: url("${fontUrl}") format("opentype");
    font-weight: 400;
    font-style: normal;
  }`;
}

function formatDims(page: SnapshotPage): string {
  const d = page.specs.dimensions_mm;
  if (d.length == null && d.width == null && d.height == null) return "—";
  return `${d.length ?? "—"} × ${d.width ?? "—"} × ${d.height ?? "—"} mm`;
}

function formatWeight(page: SnapshotPage): string {
  if (page.specs.weight_with_packaging_kg == null) return "—";
  return `${page.specs.weight_with_packaging_kg} kg`;
}

function imageTag(
  workspaceRoot: string,
  workAssetsDir: string,
  ref: { path: string; sha256: string } | null,
  alt: string,
  className: string,
): string {
  if (!ref) {
    return `<div class="img-missing ${className}">No image</div>`;
  }
  const abs = resolveUnderWorkspace(workspaceRoot, ref.path, "image");
  const ext = path.extname(abs) || ".jpg";
  const localName = `${ref.sha256.slice(0, 16)}${ext}`;
  const dest = path.join(workAssetsDir, localName);
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(abs, dest);
  }
  return `<img class="${className}" src="assets/${escapeHtml(localName)}" alt="${escapeHtml(alt)}" />`;
}

function productPageHtml(
  workspaceRoot: string,
  workAssetsDir: string,
  snapshot: CatalogSnapshot,
  page: SnapshotPage,
  pageIndex: number,
): string {
  const title = page.copy.title || page.display_name;
  const points = page.copy.selling_points
    .map((point) => `<li>${escapeHtml(point)}</li>`)
    .join("\n");
  const priceBlock =
    page.price.display != null && page.price.display !== ""
      ? `<div class="price">${escapeHtml(snapshot.price_policy.label ? `${snapshot.price_policy.label}: ` : "")}${escapeHtml(page.price.display)}</div>`
      : "";
  const category = page.category
    ? `<div class="category">${escapeHtml(page.category)}</div>`
    : "";
  const description = page.copy.description
    ? `<p class="description">${escapeHtml(page.copy.description)}</p>`
    : "";

  const slots: ImageSlot[] = ["near", "wear", "detail"];
  const near = imageTag(workspaceRoot, workAssetsDir, page.images.near, title, "img-near");
  const thumbs = slots
    .filter((slot) => slot !== "near")
    .map((slot) =>
      imageTag(workspaceRoot, workAssetsDir, page.images[slot], `${title} ${slot}`, `img-${slot}`),
    )
    .join("\n");

  return `
<section class="page product-page">
  <header class="page-header">
    <span class="brand-name">${escapeHtml(snapshot.brand.name)}</span>
    <span class="collection">${escapeHtml(snapshot.cover.title)}</span>
  </header>
  <div class="product-grid">
    <div class="visuals">
      ${near}
      <div class="thumbs">${thumbs}</div>
    </div>
    <div class="copy">
      ${category}
      <h1>${escapeHtml(title)}</h1>
      ${page.name_en && page.name_en !== title ? `<div class="name-en">${escapeHtml(page.name_en)}</div>` : ""}
      <ul class="selling-points">${points || "<li>—</li>"}</ul>
      ${description}
      <dl class="specs">
        <div><dt>Size</dt><dd>${escapeHtml(formatDims(page))}</dd></div>
        <div><dt>Weight</dt><dd>${escapeHtml(formatWeight(page))}</dd></div>
        <div><dt>SKU</dt><dd>${escapeHtml(String(page.product_id))}</dd></div>
      </dl>
      ${priceBlock}
    </div>
  </div>
  <footer class="page-footer"><span>p.${pageIndex}</span></footer>
</section>`;
}

function coverPageHtml(snapshot: CatalogSnapshot): string {
  const subtitle = snapshot.cover.subtitle
    ? `<p class="subtitle">${escapeHtml(snapshot.cover.subtitle)}</p>`
    : "";
  const tagline = snapshot.brand.tagline
    ? `<p class="tagline">${escapeHtml(snapshot.brand.tagline)}</p>`
    : "";
  return `
<section class="page cover-page">
  <div class="cover-inner">
    <div class="brand-name">${escapeHtml(snapshot.brand.name)}</div>
    ${tagline}
    <h1>${escapeHtml(snapshot.cover.title)}</h1>
    ${subtitle}
    <p class="meta">${escapeHtml(snapshot.locale.toUpperCase())} · ${escapeHtml(snapshot.market)} · ${escapeHtml(String(snapshot.pages.length))} products</p>
  </div>
</section>`;
}

function contactPageHtml(snapshot: CatalogSnapshot): string {
  const lines = snapshot.brand.contact_lines
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("\n");
  return `
<section class="page contact-page">
  <div class="contact-inner">
    <h1>Contact</h1>
    <p class="brand-name">${escapeHtml(snapshot.brand.name)}</p>
    <ul>${lines || "<li>—</li>"}</ul>
  </div>
</section>`;
}

function loadTemplateShell(templateId: string): { styles: string } {
  const dir = path.join(TEMPLATES_DIR, templateId);
  const cssPath = path.join(dir, "styles.css");
  if (!fs.existsSync(cssPath)) {
    throw new CatalogError(`template styles not found: ${templateId}`, 1);
  }
  return { styles: fs.readFileSync(cssPath, "utf-8") };
}

export function renderCatalogHtml(
  workspaceRoot: string,
  snapshot: CatalogSnapshot,
  htmlOutPath: string,
): { pageCount: number; htmlRelativeAssetsDir: string } {
  if (snapshot.template_id !== "single-product-page.v1") {
    throw new CatalogError(`unsupported template_id: ${snapshot.template_id}`, 2);
  }
  if (snapshot.include_sections.product_pages && snapshot.pages.length === 0) {
    throw new CatalogError("no products included in snapshot; refuse empty catalog", 3);
  }

  const { styles } = loadTemplateShell(snapshot.template_id);
  const workDir = path.dirname(htmlOutPath);
  const assetsDir = path.join(workDir, "assets");
  ensureDir(assetsDir);

  const sections: string[] = [];
  let pageIndex = 0;
  if (snapshot.include_sections.cover) {
    pageIndex += 1;
    sections.push(coverPageHtml(snapshot));
  }
  if (snapshot.include_sections.product_pages) {
    for (const page of snapshot.pages) {
      pageIndex += 1;
      sections.push(productPageHtml(workspaceRoot, assetsDir, snapshot, page, pageIndex));
    }
  }
  if (snapshot.include_sections.contact) {
    pageIndex += 1;
    sections.push(contactPageHtml(snapshot));
  }

  const html = `<!doctype html>
<html lang="${escapeHtml(snapshot.locale)}">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(snapshot.cover.title)}</title>
  <style>
${documentFontFaceCss()}
${styles}
  </style>
</head>
<body>
${sections.join("\n")}
</body>
</html>
`;

  ensureDir(path.dirname(htmlOutPath));
  fs.writeFileSync(htmlOutPath, html, "utf-8");
  return { pageCount: pageIndex, htmlRelativeAssetsDir: assetsDir };
}
