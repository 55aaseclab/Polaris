import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitepress";

type SidebarItem = { text: string; link?: string; items?: SidebarItem[] };

function titleize(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function readMarkdownHeading(filePath: string) {
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function fileLabel(filePath: string) {
  const basename = path.basename(filePath, path.extname(filePath));
  if (basename === "index") {
    return "Overview";
  }
  return readMarkdownHeading(filePath) ?? titleize(basename);
}

function sortSidebarEntries(left: fs.Dirent, right: fs.Dirent) {
  if (left.isDirectory() !== right.isDirectory()) {
    return left.isDirectory() ? -1 : 1;
  }
  if (left.name === "index.md" || right.name === "index.md") {
    return left.name === "index.md" ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function buildDirectoryItems(rootDir: string, currentDir = rootDir): SidebarItem[] {
  const entries = fs
    .readdirSync(currentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.name.endsWith(".md"))
    .sort(sortSidebarEntries);

  const items: SidebarItem[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      items.push({
        text: titleize(entry.name),
        items: buildDirectoryItems(rootDir, absolutePath),
      });
      continue;
    }

    const markdownPath = relativePath.replace(/\.md$/i, "");
    const linkPath = markdownPath === "index" ? "" : `/${markdownPath}`;
    items.push({
      text: fileLabel(absolutePath),
      link: `/latest${linkPath}`,
    });
  }

  return items;
}

function buildDocsSidebar() {
  const docsRoot = path.resolve(__dirname, "..", "latest");
  return [
    {
      text: "Polaris",
      items: buildDirectoryItems(docsRoot),
    },
  ];
}

export default defineConfig({
  title: "Polaris Docs",
  description: "Polaris documentation.",
  lang: "en-US",
  cleanUrls: true,
  lastUpdated: false,
  themeConfig: {
    siteTitle: "Polaris Docs",
    nav: [
      { text: "Home", link: "/" },
      { text: "Docs", link: "/latest/" },
    ],
    sidebar: {
      "/latest/": buildDocsSidebar(),
      "/": [
        {
          text: "Docs",
          items: [
            { text: "Home", link: "/" },
            { text: "Open Docs", link: "/latest/" },
          ],
        },
      ],
    },
  },
});
