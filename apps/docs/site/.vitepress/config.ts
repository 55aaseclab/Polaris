import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import type MarkdownIt from "markdown-it";

type SidebarItem = {
  text: string;
  link?: string;
  collapsed?: boolean;
  items?: SidebarItem[];
};

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sectionNames = [
  "polaris",
  "operations",
  "business-model",
];

function relativeSitePath(filePath: string): string {
  return path.relative(siteRoot, filePath).split(path.sep).join("/");
}

function humanize(value: string): string {
  return value
    .split("-")
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(" ");
}

function markdownTitle(filePath: string, fallback: string): string {
  if (!fs.existsSync(filePath)) return fallback;
  const source = fs.readFileSync(filePath, "utf8");
  const heading = source.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
  return heading?.replace(/[`*_]/g, "") || fallback;
}

function pageRoute(filePath: string): string {
  const withoutExtension = relativeSitePath(filePath).replace(/\.md$/u, "");
  if (withoutExtension === "index") return "/";
  if (withoutExtension.endsWith("/index")) {
    return `/${withoutExtension.slice(0, -"/index".length)}/`;
  }
  return `/${withoutExtension}`;
}

function hasMarkdown(directory: string): boolean {
  return fs.readdirSync(directory, { withFileTypes: true }).some((entry) => {
    if (entry.name.startsWith(".")) return false;
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile()) return entry.name.endsWith(".md");
    return entry.isDirectory() && hasMarkdown(entryPath);
  });
}

function sortEntries() {
  return (left: { name: string }, right: { name: string }): number => {
    if (left.name === "index.md") return -1;
    if (right.name === "index.md") return 1;
    return left.name.localeCompare(right.name);
  };
}

function directoryItems(directory: string, relativeDirectory: string): SidebarItem[] {
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort(sortEntries());
  const items: SidebarItem[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const entryRelativePath = relativeSitePath(entryPath);
    if (entry.isFile() && entry.name.endsWith(".md")) {
      items.push({
        text: markdownTitle(entryPath, humanize(entry.name.replace(/\.md$/u, ""))),
        link: pageRoute(entryPath),
      });
      continue;
    }
    if (!entry.isDirectory() || !hasMarkdown(entryPath)) continue;
    const childItems = directoryItems(entryPath, entryRelativePath);
    if (childItems.length === 0) continue;
    const indexPath = path.join(entryPath, "index.md");
    items.push({
      text: markdownTitle(indexPath, humanize(entry.name)),
      collapsed: true,
      items: childItems,
    });
  }

  return items;
}

function sectionTitle(section: string): string {
  return markdownTitle(
    path.join(siteRoot, section, "index.md"),
    humanize(section),
  );
}

function sectionSidebar(section: string): SidebarItem[] {
  const directory = path.join(siteRoot, section);
  return [{
    text: sectionTitle(section),
    items: directoryItems(directory, section),
  }];
}

const primaryNavSections = ["polaris", "operations"];
const primarySections = sectionNames.filter((section) => primaryNavSections.includes(section));
const referenceSections = sectionNames.filter((section) => !primaryNavSections.includes(section));
const nav = [
  ...primarySections.map((section) => ({
    text: sectionTitle(section),
    link: `/${section}/`,
  })),
  ...(referenceSections.length > 0
    ? [{
      text: "Reference",
      items: referenceSections.map((section) => ({
        text: sectionTitle(section),
        link: `/${section}/`,
      })),
    }]
    : []),
];

const homeSidebar: SidebarItem[] = [{
  text: "Start Here",
  items: [
    { text: "Documentation Home", link: "/" },
    ...sectionNames.map((section) => ({
      text: sectionTitle(section),
      link: `/${section}/`,
    })),
  ],
}];

function mermaidFencePlugin(md: MarkdownIt) {
  const defaultFence = md.renderer.rules.fence?.bind(md.renderer.rules);

  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const language = token.info.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";

    if (language === "mermaid") {
      return "<pre class=\"mermaid\">" + md.utils.escapeHtml(token.content.trim()) + "</pre>\n";
    }

    if (defaultFence) {
      return defaultFence(tokens, idx, options, env, self);
    }

    return self.renderToken(tokens, idx, options);
  };
}

export default defineConfig({
  title: "Polaris Docs",
  description: "Official Polaris documentation for product, platform, and operations.",
  lang: "en-US",
  cleanUrls: true,
  lastUpdated: true,
  markdown: {
    config(md) {
      mermaidFencePlugin(md);
    },
  },
  vite: {
    server: {
      allowedHosts: ["oximetric-katabolic-shameka.ngrok-free.dev"],
    },
  },
  themeConfig: {
    siteTitle: "Polaris Docs",
    nav,
    sidebar: {
      ...Object.fromEntries(sectionNames.map((section) => [`/${section}/`, sectionSidebar(section)])),
      "/": homeSidebar,
    },
  },
});
