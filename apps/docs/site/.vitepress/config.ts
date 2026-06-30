import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitepress";
import { docsDiffs } from "./theme/generated/docs-data.ts";

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

function buildDirectoryItems(version: string, rootDir: string, currentDir = rootDir): SidebarItem[] {
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
        items: buildDirectoryItems(version, rootDir, absolutePath),
      });
      continue;
    }

    const markdownPath = relativePath.replace(/\.md$/i, "");
    const linkPath = markdownPath === "index" ? "" : `/${markdownPath}`;
    items.push({
      text: fileLabel(absolutePath),
      link: `/${version}${linkPath}`,
    });
  }

  return items;
}

function buildVersionSidebar(version: string) {
  const versionRoot = path.resolve(__dirname, "..", version);
  return [
    {
      text: version === "latest" ? "Latest" : version,
      items: buildDirectoryItems(version, versionRoot),
    },
  ];
}

function diffFileLabel(filePath: string) {
  const parts = filePath.split("/");
  const last = parts.at(-1) ?? filePath;
  if (last === "index.md") {
    return parts.length > 1 ? `${titleize(parts[0] ?? "")} Overview` : "Overview";
  }
  return titleize(last.replace(/\.md$/i, ""));
}

function buildDiffSidebar() {
  const filePaths = Array.from(
    new Set(
      docsDiffs
        .filter((entry) => entry.leftVersion === "0.2.4" && entry.rightVersion === "latest")
        .map((entry) => entry.path),
    ),
  ).sort();

  const rootItems: Array<{ text: string; link: string }> = [];
  const groups = new Map<string, Array<{ text: string; link: string }>>();

  for (const filePath of filePaths) {
    const parts = filePath.split("/");
    const slug = filePath
      .replace(/\.md$/i, "")
      .replace(/^index$/i, "overview")
      .split("/")
      .map((part) => part.replace(/[^a-zA-Z0-9-_]/g, "-"))
      .join("/");
    const link = `/diff/${slug}`;
    if (filePath === "index.md") {
      continue;
    }
    if (parts.length === 1) {
      rootItems.push({ text: diffFileLabel(filePath), link });
      continue;
    }
    const group = parts[0]!;
    const itemText = diffFileLabel(filePath);
    const items = groups.get(group) ?? [];
    items.push({ text: itemText, link });
    groups.set(group, items);
  }

  const sidebar: Array<{ text?: string; items: Array<{ text: string; link: string }> }> = [];

  if (rootItems.length > 0) {
    sidebar.push({
      text: "Files",
      items: rootItems,
    });
  }

  for (const [group, items] of Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    sidebar.push({
      text: titleize(group),
      items,
    });
  }

  return sidebar;
}

export default defineConfig({
  title: "Polaris Docs",
  description: "Versioned Polaris documentation with inline diff browsing.",
  lang: "en-US",
  cleanUrls: true,
  lastUpdated: false,
  themeConfig: {
    siteTitle: "Polaris Docs",
    nav: [
      { text: "Latest", link: "/latest/" },
      { text: "0.2.4", link: "/0.2.4/" },
      { text: "Diff", link: "/diff/" },
    ],
    sidebar: {
      "/latest/": buildVersionSidebar("latest"),
      "/0.2.4/": buildVersionSidebar("0.2.4"),
      "/diff/": [
        {
          text: "Diff",
          items: [
            { text: "Overview", link: "/diff/" },
          ],
        },
        ...buildDiffSidebar(),
      ],
      "/": [
        {
          text: "Docs",
          items: [
            { text: "Home", link: "/" },
            { text: "Diff", link: "/diff/" },
          ],
        },
      ],
    },
  },
});
