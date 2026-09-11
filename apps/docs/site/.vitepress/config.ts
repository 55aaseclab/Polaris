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

const directoryOrder: Record<string, string[]> = {
  polaris: [
    "index.md",
    "usage.md",
    "user-management.md",
    "polaris-portal.md",
    "tool-portal.md",
    "dsl.md",
    "vault-management.md",
    "gateway.md",
    "paseo.md",
    "cli.md",
    "literature-review-live-design.md",
  ],
  operations: [
    "index.md",
    "remote-deploy.md",
    "infamous-regression.md",
    "topology.md",
    "polaris-release",
    "polaris-0.3.1",
    "polaris-0.3.2",
    "polaris-0.3.3",
    "polaris-0.3.4",
    "polaris-0.4.0",
    "polaris-0.5.0",
  ],
  "operations/polaris-release": [
    "index.md",
    "0.3-design.md",
    "0.3-release-todo.md",
    "0.3-release-evidence.md",
    "0.3-operator-runbook.md",
  ],
  "operations/polaris-0.3.1": [
    "index.md",
    "performance-plan.md",
    "gateway-performance-evidence-2026-08-06.md",
    "host-list-performance-evidence-2026-08-06.md",
    "control-plane-performance-evidence-2026-08-06.md",
  ],
  "operations/polaris-0.3.2": [
    "index.md",
    "production-perimeter-plan.md",
    "signed-image-evidence-2026-08-06.md",
    "formal-origin-online-2026-08-09.md",
    "formal-origin-post-bump-online-2026-08-09.md",
    "formal-tls-and-perimeter-2026-08-09.md",
    "formal-rollback-drill-2026-08-09.md",
  ],
  "operations/polaris-0.3.3": [
    "index.md",
    "user-growth-and-capacity-plan.md",
    "test-host-bringup.md",
    "concurrent-capacity-evidence-2026-08-09.md",
    "test-host-smoke-2026-08-09.md",
    "epfl-verify-2026-08-09.md",
    "twenty-user-resource-baseline.md",
    "release-ship-2026-08-09.md",
    "post-release-control-vault-data-2026-08-10.md",
  ],
  "operations/polaris-0.3.4": ["index.md"],
  "operations/polaris-0.4.0": [
    "index.md",
    "work-envelope-and-workflow-plan.md",
    "dynamic-workflow-runtime.md",
    "polaris-dsl-as-workflow-ir.md",
  ],
  "operations/polaris-0.5.0": ["index.md", "scenario-driven-improvements.md"],
  "business-model": [
    "index.md",
    "customer-segment-analysis.md",
    "product-matrix.md",
    "use-scenarios.md",
    "api-relay-pricing-comparison-2026-09-08.md",
    "china-model-price-ranking-v2-2026-09-08.md",
    "target-customers-and-roadmap.md",
    "non-target-customers.md",
  ],
};

const directoryLabels: Record<string, string> = {
  "operations/polaris-release": "Polaris 0.3 Release (Archived)",
  "operations/polaris-0.3.1": "Polaris 0.3.1 Performance (Archived)",
  "operations/polaris-0.3.2": "Polaris 0.3.2 Production (Archived)",
  "operations/polaris-0.3.3": "Polaris 0.3.3 Capacity (Archived)",
  "operations/polaris-0.3.4": "Polaris 0.3.4 (Current)",
  "operations/polaris-0.4.0": "Polaris 0.4.0 Workflows",
  "operations/polaris-0.5.0": "Polaris 0.5.0 Local Cell",
};

const sectionLabels: Record<string, string> = {
  polaris: "Polaris",
  operations: "Operations",
  "business-model": "Business Model",
};

const sectionOrder = [
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

function entryRank(relativeDirectory: string, entryName: string): number {
  const order = directoryOrder[relativeDirectory] ?? [];
  const knownIndex = order.indexOf(entryName);
  return knownIndex === -1 ? order.length : knownIndex;
}

function sortEntries(relativeDirectory: string) {
  return (left: { name: string }, right: { name: string }): number => {
    const rankDifference = entryRank(relativeDirectory, left.name)
      - entryRank(relativeDirectory, right.name);
    return rankDifference || left.name.localeCompare(right.name);
  };
}

function directoryItems(
  directory: string,
  relativeDirectory: string,
): SidebarItem[] {
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort(sortEntries(relativeDirectory));
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
      text: directoryLabels[entryRelativePath]
        || markdownTitle(indexPath, humanize(entry.name)),
      collapsed: true,
      items: childItems,
    });
  }

  return items;
}

function sectionSidebar(section: string): SidebarItem[] {
  const directory = path.join(siteRoot, section);
  return [{
    text: sectionLabels[section] || markdownTitle(
      path.join(directory, "index.md"),
      humanize(section),
    ),
    items: directoryItems(directory, section),
  }];
}

const sectionNames = [...sectionOrder];
const primaryNavSections = ["polaris", "operations"];
const primarySections = sectionNames.filter((section) => primaryNavSections.includes(section));
const referenceSections = sectionNames.filter((section) => !primaryNavSections.includes(section));
const nav = [
  ...primarySections.map((section) => ({
    text: sectionLabels[section] || humanize(section),
    link: `/${section}/`,
  })),
  ...(referenceSections.length > 0
    ? [{
      text: "Reference",
      items: referenceSections.map((section) => ({
        text: sectionLabels[section] || humanize(section),
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
      text: sectionLabels[section] || humanize(section),
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
