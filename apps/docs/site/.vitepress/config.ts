import { defineConfig } from "vitepress";
import { docsVersions } from "./theme/generated/docs-data.ts";

function titleize(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
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
    new Set(docsVersions.flatMap((version) => version.files.map((file) => file.path))),
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
      { text: "0.2.2", link: "/0.2.2/" },
      { text: "Diff", link: "/diff/" },
    ],
    sidebar: {
      "/latest/": [
        {
          text: "Latest",
          items: [
            { text: "Overview", link: "/latest/" },
            { text: "Version", link: "/latest/VERSION" },
            { text: "Changelog", link: "/latest/CHANGELOG" },
          ],
        },
        {
          text: "Polaris",
          items: [
            { text: "Overview", link: "/latest/polaris/" },
            { text: "Isolation Maturity", link: "/latest/polaris/isolation-maturity" },
            { text: "Agent Swarm Maturity", link: "/latest/polaris/agent-swarm-maturity" },
            { text: "Evolution Maturity", link: "/latest/polaris/evolution-maturity" },
            { text: "User Management Maturity", link: "/latest/polaris/user-management-maturity" },
          ],
        },
        {
          text: "Operations",
          items: [
            { text: "Remote Deploy", link: "/latest/operations/remote-deploy" },
            { text: "K3s Multi-Machine Setup", link: "/latest/operations/setup-k3s-across-multiple-machines" },
          ],
        },
        {
          text: "Tooling",
          items: [
            { text: "Workspace README", link: "/latest/tooling/workspace/" },
            { text: "Host README", link: "/latest/tooling/host/" },
            { text: "Alacritty", link: "/latest/tooling/host/alacritty" },
          ],
        },
      ],
      "/0.2.2/": [
        {
          text: "0.2.2",
          items: [
            { text: "Overview", link: "/0.2.2/" },
          ],
        },
        {
          text: "Polaris",
          items: [
            { text: "Overview", link: "/0.2.2/polaris/" },
            { text: "Isolation Maturity", link: "/0.2.2/polaris/isolation-maturity" },
            { text: "Agent Swarm Maturity", link: "/0.2.2/polaris/agent-swarm-maturity" },
            { text: "Evolution Maturity", link: "/0.2.2/polaris/evolution-maturity" },
            { text: "User Management Maturity", link: "/0.2.2/polaris/user-management-maturity" },
          ],
        },
        {
          text: "Operations",
          items: [
            { text: "Remote Deploy", link: "/0.2.2/operations/remote-deploy" },
            { text: "K3s Multi-Machine Setup", link: "/0.2.2/operations/setup-k3s-across-multiple-machines" },
          ],
        },
        {
          text: "Tooling",
          items: [
            { text: "Workspace README", link: "/0.2.2/tooling/workspace/" },
            { text: "Host README", link: "/0.2.2/tooling/host/" },
            { text: "Alacritty", link: "/0.2.2/tooling/host/alacritty" },
          ],
        },
      ],
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
